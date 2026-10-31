import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAccountUsage, parseCatalog } from "../src/app-server-catalog.js";
import { DesktopIpcClient } from "../src/desktop-ipc-client.js";
import { buildLocalSnapshot, LocalCodexBridge } from "../src/local-codex-bridge.js";
import type { CodexMicroRendererBridge } from "../src/codex-micro-renderer-bridge.js";
import { encodeIpcFrame, IpcFrameDecoder, type ObjectValue } from "../src/local-ipc-protocol.js";
import { probeLocalIpc } from "../src/experimental/local-ipc-probe.js";
import { renderFallbackKeycap, renderUnavailableAction } from "../src/render.js";
import type { UsageSnapshot } from "../src/types.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Fixture condition timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

test("account usage respects actual window durations and drops unrelated account fields", () => {
  const usage = parseAccountUsage({ accountId: "private account", rateLimits: { primary: {
    usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_800_000_000
  } }, rateLimitsByLimitId: { other: { primary: { usedPercent: 99 } } } }, 123)!;
  assert.equal(usage.windows[0]?.kind, "weekly");
  assert.equal(usage.windows[0]?.remainingPercent, 80);
  assert.equal(usage.windows[0]?.resetsAt, 1_800_000_000_000);
  assert.doesNotMatch(JSON.stringify(usage), /private account|other/);
  assert.equal(parseAccountUsage({ rateLimits: { primary: { usedPercent: 101 } } }), undefined);
});

test("recent catalog uses recency, excludes children/ephemeral/invalid IDs and bounds display metadata", () => {
  const rows = Array.from({ length: 8 }, (_, n) => ({ id: id(n), recencyAt: 100 + n, updatedAt: 999 - n,
    name: `Task ${n}\n`, preview: "Do not retain this prompt", cwd: "/fixture/project", turns: ["private answer"] }));
  const threads = parseCatalog({ data: [...rows, { ...rows[7], parentThreadId: id(0), id: id(80), recencyAt: 999 },
    { ...rows[7], ephemeral: true, id: id(81), recencyAt: 999 }, { id: "../../secret" }, rows[7]] });
  assert.deepEqual(threads.map((t) => t.id), [7, 6, 5, 4, 3, 2].map(id));
  assert.equal(threads[0]?.projectName, "project");
  assert.equal(threads[0]?.title, "Task 7");
  assert.doesNotMatch(JSON.stringify(threads), /private answer|Do not retain|fixture/);
  assert.throws(() => parseCatalog({ data: null }));
});

test("history never supplies unread or UI focus, and IPC runtime takes precedence", () => {
  const threads = parseCatalog({ data: [{ id: id(1), name: "one", recencyAt: 1 }] });
  threads[0]!.historyStatus = "idle";
  const history = buildLocalSnapshot(threads, { current: () => undefined });
  assert.equal(history.slots[0]?.status, "idle");
  assert.equal(history.slots[0]?.statusOrigin, "history");
  assert.equal(history.activeThreadKey, undefined);
  const live = buildLocalSnapshot(threads, { current: () => ({ state: {
    revision: 1, runtime: { type: "active", activeFlags: ["waitingOnApproval"] }, unread: true
  }, title: "Live title" }) });
  assert.equal(live.slots[0]?.status, "awaiting-approval");
  assert.equal(live.slots[0]?.title, "Live title");
  assert.equal(live.slots[0]?.selected, false);
  assert.equal(live.slots[5]?.status, "off");
  assert.equal(live.layout.slots.ACT10_ACT11?.keycapId, "MIC");
});

test("unavailable controls keep their icon and add a launcher requirement badge", () => {
  const original = renderFallbackKeycap("MIC", "dark");
  const svg = decodeURIComponent(renderUnavailableAction(original).split(",").slice(1).join(","));
  assert.match(svg, /data-icon-source="fallback-label"[^>]*>MIC<\/text>/);
  assert.match(svg, /data-action-requirement="launcher"/);
});

test("normal macOS mode never calls the debug bridge, including keys pressed before its first snapshot", async () => {
  let calls = 0;
  const native = { refresh: async () => { calls++; throw new Error("native fixture"); },
    sendAction: async () => { calls++; }, close: () => {} } as unknown as CodexMicroRendererBridge;
  const bridge = new LocalCodexBridge(() => {}, () => {}, { platform: "darwin", native });
  try {
    await assert.rejects(bridge.refresh(), /desktop IPC/);
    await assert.rejects(bridge.sendAction("ACT07", 1), /not yet supported/);
    assert.equal(calls, 0);
    bridge.setConnectionMode("native");
    await assert.rejects(bridge.refresh(), /native fixture/);
    assert.equal(calls, 1);
  } finally { bridge.close(); }
  const windows = new LocalCodexBridge(() => {}, () => {}, { platform: "win32", native });
  try { await assert.rejects(windows.refresh(), /native fixture/); assert.equal(calls, 2); }
  finally { windows.close(); }
});

async function fixture(handle: (packet: ObjectValue, send: (p: ObjectValue) => void, socket: Socket) => void) {
  const directory = await mkdtemp(join(tmpdir(), "codex-deck-ipc-"));
  const path = join(directory, "ipc.sock");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    const decoder = new IpcFrameDecoder();
    socket.on("data", (bytes: Buffer) => {
      for (const p of decoder.push(bytes)) handle(p, (m) => socket.write(encodeIpcFrame(m)), socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  await chmod(path, 0o600);
  return { path, sockets, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}

const response = (p: ObjectValue, result: ObjectValue = {}) => ({ type: "response", requestId: p.requestId,
  resultType: "success", handledByClientId: "fixture-owner", result });
const state = (thread: string, change: ObjectValue) => ({ type: "broadcast", method: "thread-stream-state-changed", version: 11,
  sourceClientId: "fixture-owner", params: { hostId: "local", conversationId: thread, change } });

test("account reads do not block status, update later, and cannot supply expired usage", { skip: process.platform === "win32" }, async () => {
  const f = await fixture((p, send) => { if (p.method === "initialize") send(response(p, { clientId: "fixture-client" })); });
  let resolveUsage!: (value: UsageSnapshot) => void;
  const pendingUsage = new Promise<UsageSnapshot>((resolve) => { resolveUsage = resolve; });
  const bridge = new LocalCodexBridge(() => {}, () => {}, { platform: "darwin", socketPath: f.path,
    catalog: { recent: async () => [], usage: () => pendingUsage, close: () => {} } });
  bridge.start();
  try {
    await until(() => bridge.ipc.connected);
    const initial = await bridge.refresh();
    assert.equal(initial.usage, undefined);
    resolveUsage(parseAccountUsage({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 10_080 } } })!);
    await pendingUsage;
    assert.equal((await bridge.refresh()).usage?.windows[0]?.remainingPercent, 88);
  } finally { bridge.close(); await f.close(); }
  const f2 = await fixture((p, send) => { if (p.method === "initialize") send(response(p, { clientId: "fixture-client" })); });
  const stale = new LocalCodexBridge(() => {}, () => {}, { platform: "darwin", socketPath: f2.path,
    catalog: { recent: async () => [], usage: async () => parseAccountUsage({ rateLimits: { primary: { usedPercent: 12 } } }, Date.now() - 61_000), close: () => {} } });
  stale.start();
  try { await until(() => stale.ipc.connected); assert.equal((await stale.refresh()).usage, undefined); }
  finally { stale.close(); await f2.close(); }
});

test("persistent IPC follows exact targets, repairs revision gaps and drops status on disconnect", { skip: process.platform === "win32" }, async () => {
  let sendToClient: ((p: ObjectValue) => void) | undefined;
  let subscriptions = 0;
  const f = await fixture((p, send) => {
    sendToClient = send;
    if (p.method === "initialize") send(response(p, { clientId: "fixture-client" }));
    if (p.method === "thread-owner-discovery") send(response(p));
    if (p.method === "thread-stream-following-changed" && (p.params as ObjectValue).following === true) {
      subscriptions++;
      send(state(id(1), { type: "snapshot", revision: subscriptions * 10, conversationState: {
        title: "Display title", turns: [{ text: "secret prompt" }], threadRuntimeStatus: { type: "active" }, hasUnreadTurn: false
      } }));
    }
  });
  const client = new DesktopIpcClient(() => {}, { socketPath: f.path, retryMs: 20, timeoutMs: 1_000, resyncMs: 30_000 });
  client.setTargets([id(1)]); client.start();
  try {
    await until(() => client.current(id(1))?.state != null);
    assert.doesNotMatch(JSON.stringify(client.current(id(1))), /secret prompt|turns/);
    sendToClient!(state(id(2), { type: "snapshot", revision: 1, conversationState: { threadRuntimeStatus: { type: "systemError" } } }));
    assert.equal(client.current(id(2)), undefined);
    sendToClient!(state(id(1), { type: "patches", baseRevision: -1, revision: 12, patches: [] }));
    await until(() => subscriptions >= 2 && client.current(id(1))?.state?.revision === 20);
    for (const socket of f.sockets) socket.destroy();
    await until(() => !client.connected);
    assert.equal(client.current(id(1))?.state, undefined);
    await until(() => client.connected && client.current(id(1))?.state != null);
    client.setTargets([]);
    assert.equal(client.current(id(1)), undefined);
  } finally { client.close(); await f.close(); }
});

test("explicit probe cannot report another observed chat as success", { skip: process.platform === "win32" }, async () => {
  const f = await fixture((p, send) => {
    if (p.method === "initialize") {
      send(response(p, { clientId: "probe-client" }));
      send({ type: "broadcast", method: "thread-stream-following-changed", version: 1, sourceClientId: "renderer",
        params: { hostId: "local", conversationId: id(2), following: true } });
    }
    if (p.method === "thread-owner-discovery") {
      if ((p.params as ObjectValue).conversationId === id(2)) send(response(p));
      else send({ type: "response", requestId: p.requestId, resultType: "error", error: "no-client-found" });
    }
    if (p.method === "thread-stream-following-changed") send(state(id(2), { type: "snapshot", revision: 1,
      conversationState: { threadRuntimeStatus: { type: "active" } } }));
  });
  try {
    const report = await probeLocalIpc({ socketPath: f.path, durationMs: 150, threadId: id(1) });
    assert.equal(report.initialized, true); assert.equal(report.ownerLookups, 1);
    assert.equal(report.ownersFound, 0); assert.equal(report.snapshots, 0); assert.deepEqual(report.observedStatuses, []);
  } finally { await f.close(); }
});

test("body-only updates advance the revision without triggering display refresh or resnapshot", { skip: process.platform === "win32" }, async () => {
  let emit!: (p: ObjectValue) => void;
  let notifications = 0;
  const f = await fixture((p, send) => {
    emit = send;
    if (p.method === "initialize") send(response(p, { clientId: "fixture-client" }));
    if (p.method === "thread-owner-discovery") send(response(p));
    if (p.method === "thread-stream-following-changed" && (p.params as ObjectValue).following === true) send(state(id(1), {
      type: "snapshot", revision: 0, conversationState: { threadRuntimeStatus: { type: "active" } }
    }));
  });
  const client = new DesktopIpcClient(() => { notifications++; }, { socketPath: f.path, retryMs: 20 });
  client.setTargets([id(1)]); client.start();
  try {
    await until(() => client.current(id(1))?.state != null);
    const before = notifications;
    for (let n = 1; n <= 50; n++) emit(state(id(1), { type: "patches", baseRevision: n - 1, revision: n, patches: [
      { op: "add", path: ["turns", 0, "text"], value: "fixture body" }
    ] }));
    await until(() => client.current(id(1))?.state?.revision === 50);
    assert.equal(notifications, before);
    assert.equal(client.diagnostics().snapshotsRequested, 1);
    emit(state(id(1), { type: "patches", baseRevision: 50, revision: 51, patches: [
      { op: "replace", path: ["threadRuntimeStatus"], value: { type: "idle" } }
    ] }));
    await until(() => client.current(id(1))?.state?.revision === 51);
    assert.equal(notifications, before + 1);
  } finally { client.close(); await f.close(); }
});

test("excess IPC traffic disconnects with a cooldown and drops potentially stale live status", { skip: process.platform === "win32" }, async () => {
  let emit!: (p: ObjectValue) => void;
  const f = await fixture((p, send) => {
    emit = send;
    if (p.method === "initialize") send(response(p, { clientId: "fixture-client" }));
    if (p.method === "thread-owner-discovery") send(response(p));
    if (p.method === "thread-stream-following-changed" && (p.params as ObjectValue).following === true) send(state(id(1), {
      type: "snapshot", revision: 0, conversationState: { threadRuntimeStatus: { type: "active" } }
    }));
  });
  const client = new DesktopIpcClient(() => {}, { socketPath: f.path, retryMs: 20, maxWindowBytes: 4096, cooldownMs: 500 });
  client.setTargets([id(1)]); client.start();
  try {
    await until(() => client.current(id(1))?.state != null);
    emit({ type: "fixture", body: "x".repeat(8192) });
    await until(() => client.throttled && !client.connected);
    assert.equal(client.current(id(1))?.state, undefined);
    assert.equal(client.diagnostics().budgetStops, 1);
    await until(() => !client.throttled && client.current(id(1))?.state != null);
  } finally { client.close(); await f.close(); }
});
