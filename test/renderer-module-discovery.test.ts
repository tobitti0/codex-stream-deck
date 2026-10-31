import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { buildMicroSnapshotExpression, isMicroRendererModule } from "../src/codex-micro-renderer-bridge.js";

const sharedUrl = "app://-/assets/app-shared-fixture.js";
const slotUrl = "app://-/assets/codex-micro-slot-signals-fixture.js";

test("renderer module inventory accepts only local relevant script URLs", () => {
  for (const url of [sharedUrl, slotUrl, "app://-/assets/app-initial-fixture.js"]) {
    assert.equal(isMicroRendererModule(url), true);
  }
  for (const url of [
    "https://example.com/assets/app-shared-fixture.js", "app://other/assets/app-shared-fixture.js",
    `${sharedUrl}?other`, `${sharedUrl}#other`, "app://-/assets/unrelated-fixture.js", "not a URL"
  ]) assert.equal(isMicroRendererModule(url), false);
});

async function snapshotFixture(separateSlotModule: boolean, queries: unknown[] = []) {
  const slots = Array.from({ length: 6 }, (_, id) => ({
    id, threadKey: `fixture-${id}`, title: `Task ${id}`, status: id === 0 ? "working" : "idle", selected: id === 0
  }));
  const atom = {};
  const resolver = { resolve: () => atom, createSubscriberAtom: () => ({}) };
  const store = { get: (requested: unknown) => requested === atom ? slots : undefined };
  const queryClient = { getQueryCache: () => ({ getAll: () => queries }), getQueryData: () => undefined };
  const chain = new Map([["app", { store }]]);
  const root = { __reactContainer$fixture: {
    memoizedProps: { value: queryClient }, child: {
      memoizedProps: { value: chain }, child: null, sibling: null
    }, sibling: null
  } };
  const shared = {
    definitions: { layout: { key: "codex-micro-layout", default: { version: 1, slots: {} } },
      agentSource: { key: "codex-micro-agent-source", default: "recent" } },
    bus: { handlers: new Map([["codex-micro-hid-event", new Set([() => {}])]]), dispatchHostMessage() {} },
    ...(!separateSlotModule ? { resolver } : {})
  };
  const modules = new Map<string, object>([[sharedUrl, shared], [slotUrl, { resolver }]]);
  const urls = separateSlotModule ? [sharedUrl, slotUrl] : [sharedUrl];
  const imported: string[] = [];
  const html = { dataset: { theme: "dark" }, className: "dark" };
  const expression = buildMicroSnapshotExpression([...urls, "https://example.com/assets/app-shared-other.js"])
    .replaceAll("import(", "__import(");
  const snapshot = await runInNewContext(expression, {
    Map, Set, Symbol,
    __import: async (url: string) => { imported.push(url); assert.ok(modules.has(url)); return modules.get(url); },
    document: { querySelectorAll: () => [], querySelector: () => null, getElementById: () => root,
      documentElement: html, body: html },
    performance: { getEntriesByType: () => [] },
    getComputedStyle: () => ({ colorScheme: "dark", backgroundColor: "rgb(20,20,20)" }),
    matchMedia: () => ({ matches: true })
  });
  assert.equal(imported.some((url) => url.startsWith("https:")), false);
  return JSON.parse(JSON.stringify(snapshot));
}

for (const separate of [true, false]) {
  test(`six-slot snapshot survives cleared resource timing (${separate ? "separate" : "shared"} slot module)`, async () => {
    const snapshot = await snapshotFixture(separate);
    assert.deepEqual(snapshot.slots.map((slot: { id: number }) => slot.id), [0, 1, 2, 3, 4, 5]);
    assert.equal(snapshot.slots[0].status, "working");
    assert.equal(snapshot.theme, "dark");
  });
}

const usageData = { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18_000 } } };
const usageQuery = (key: unknown[], active: boolean, populated = true) => ({
  queryKey: key, getObserversCount: () => active ? 1 : 0,
  state: { data: populated ? usageData : undefined, dataUpdatedAt: Date.now() }
});

test("usage reads the active populated account query and ignores pending or inactive accounts", async () => {
  const snapshot = await snapshotFixture(true, [
    usageQuery(["rate-limit-status", "local", "pending", undefined], true, false),
    usageQuery(["rate-limit-status", "local", "old-account"], false),
    usageQuery(["rate-limit-status", "local", "active-account"], true)
  ]);
  assert.equal(snapshot.usage.windows[0].kind, "five-hour");
  assert.equal(snapshot.usage.windows[0].remainingPercent, 75);
});

test("usage stays unavailable when multiple active accounts are ambiguous", async () => {
  const snapshot = await snapshotFixture(true, [
    usageQuery(["rate-limit-status", "local", "one"], true),
    usageQuery(["rate-limit-status", "local", "two"], true)
  ]);
  assert.equal(snapshot.usage, undefined);
});

test("legacy unscoped usage queries remain supported", async () => {
  const snapshot = await snapshotFixture(true, [usageQuery(["rate-limit-status"], false)]);
  assert.equal(snapshot.usage.windows[0].remainingPercent, 75);
});
