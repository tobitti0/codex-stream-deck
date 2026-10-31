import assert from "node:assert/strict";
import test from "node:test";
import { MacDictationDriver, MacOsDictation, type DictationCommand, type DictationDriver } from "../src/macos-dictation.js";
import { createConnection, type Socket } from "node:net";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { talkTransition } from "../src/push-to-talk.js";
import { renderFallbackKeycap, renderMicrophoneAction } from "../src/render.js";
import { LocalCodexBridge } from "../src/local-codex-bridge.js";
import type { CodexMicroRendererBridge } from "../src/codex-micro-renderer-bridge.js";

test("Micro hold, short tap and double press use one recording and explicit stop", () => {
  const first = talkTransition({ kind: "idle" }, "down", 1000);
  assert.equal(first.effect, "start");
  assert.equal(talkTransition(first.state, "down", 1100).effect, undefined);
  assert.equal(talkTransition(first.state, "up", 1400).effect, "stop");
  const tap = talkTransition(first.state, "up", 1100);
  assert.deepEqual(tap.state, { kind: "waiting", until: 1350 });
  assert.equal(talkTransition(tap.state, "timeout", 1350).effect, "stop");
  const latch = talkTransition(tap.state, "down", 1200);
  assert.equal(latch.effect, "latch");
  assert.equal(talkTransition(latch.state, "up", 1250).effect, undefined);
  assert.equal(talkTransition(latch.state, "down", 1800).effect, "stop");
  assert.equal(talkTransition({ kind: "idle" }, "up", 1900).effect, undefined);
});

function fixture() {
  const calls: { command: DictationCommand; session: string }[] = [];
  let finishStart!: () => void;
  const pending = new Promise<void>((resolve) => { finishStart = resolve; });
  const driver: DictationDriver = {
    async command(command, session) { calls.push({ command, session }); if (command === "start") await pending; },
    close() {}
  };
  return { calls, driver, finishStart };
}

test("a release arriving during a slow start stops the same owned session after confirmation", async () => {
  const f = fixture(); const dictation = new MacOsDictation(() => {}, () => {}, f.driver);
  try {
    const start = dictation.key(1); await Promise.resolve();
    assert.equal(dictation.state, "starting");
    const release = dictation.key(0); await release;
    await new Promise((resolve) => setTimeout(resolve, 370));
    assert.deepEqual(f.calls.map((c) => c.command), ["start"]);
    f.finishStart(); await start;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(f.calls.map((c) => c.command), ["start", "stop"]);
    assert.equal(f.calls[0]?.session, f.calls[1]?.session);
    assert.equal(dictation.state, "idle");
  } finally { dictation.close(); }
});

test("failed or externally owned starts never cause a stop or claim recording", async () => {
  const calls: DictationCommand[] = [];
  const dictation = new MacOsDictation(() => {}, () => {}, {
    async command(command) { calls.push(command); throw new Error("ChatGPT is already recording"); }, close() {}
  });
  try {
    await assert.rejects(dictation.key(1), /already recording/);
    await dictation.key(0);
    assert.equal(dictation.state, "error");
    assert.deepEqual(calls, ["start"]);
  } finally { dictation.close(); }
});

test("permission failure is explicit, and a later user press can retry", async () => {
  let allowed = false;
  const dictation = new MacOsDictation(() => {}, () => {}, {
    async command() { if (!allowed) throw new Error("Allow Accessibility"); }, close() {}
  });
  try {
    await assert.rejects(dictation.key(1), /Accessibility/);
    assert.equal(dictation.state, "permission-required");
    allowed = true; await dictation.key(1);
    assert.equal(dictation.state, "recording");
    dictation.cancel(); await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(dictation.state, "idle");
  } finally { dictation.close(); }
});

test("normal-mode microphone bypasses the debug bridge while native mode retains native routing", async () => {
  let nativeCalls = 0; const calls: DictationCommand[] = [];
  const native = { sendAction: async () => { nativeCalls++; }, close() {} } as unknown as CodexMicroRendererBridge;
  const bridge = new LocalCodexBridge(() => {}, () => {}, { platform: "darwin", native,
    dictationDriver: { command: async (command) => { calls.push(command); }, close() {} } });
  try {
    await bridge.sendAction("ACT10_ACT11", 1);
    assert.deepEqual(calls, ["start"]); assert.equal(nativeCalls, 0);
    bridge.setConnectionMode("native");
    await bridge.sendAction("ACT10_ACT11", 0);
    assert.equal(nativeCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, ["start", "stop"]);
  } finally { bridge.close(); }
});

test("microphone artwork shows recording only for a confirmed state and removes the Launcher badge", () => {
  const image = renderFallbackKeycap("MIC", "dark");
  const render = (state: Parameters<typeof renderMicrophoneAction>[1]) => decodeURIComponent(renderMicrophoneAction(image, state).split(",").slice(1).join(","));
  assert.match(render("starting"), /data-microphone-state="starting"/);
  assert.doesNotMatch(render("starting"), />REC</);
  assert.match(render("recording"), />REC</);
  assert.match(render("permission-required"), />Allow AX</);
  assert.doesNotMatch(render("idle"), /Launcher/);
});

test("private microphone transport authenticates its helper and translates only known error codes", { skip: process.platform === "win32" }, async () => {
  let connection: Socket | undefined;
  let endpoint = "";
  const packets: Record<string, unknown>[] = [];
  const driver = new MacDictationDriver(() => {}, "fixture-app", async (_app, path, token) => {
    endpoint = path;
    assert.equal((await lstat(dirname(path))).mode & 0o077, 0);
    assert.equal((await lstat(path)).mode & 0o077, 0);
    connection = createConnection(path);
    connection.setEncoding("utf8");
    connection.on("connect", () => connection!.write(`${JSON.stringify({ token })}\n`));
    let buffer = "";
    connection.on("data", (data) => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const packet = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); packets.push(packet);
        connection!.write(`${JSON.stringify(packet.command === "start" ? { id: packet.id, ok: true } : { id: packet.id, error: "accessibility", privateText: "must not expose" })}\n`);
      }
    });
  });
  try {
    await driver.command("start", "fixture-session");
    await assert.rejects(driver.command("stop", "fixture-session"), (error: Error) => {
      assert.match(error.message, /Accessibility/); assert.doesNotMatch(error.message, /must not expose/); return true;
    });
    assert.deepEqual(packets.map(({ command, session }) => ({ command, session })), [
      { command: "start", session: "fixture-session" }, { command: "stop", session: "fixture-session" }
    ]);
  } finally {
    driver.close(); connection?.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(lstat(endpoint), /ENOENT/);
  }
});
