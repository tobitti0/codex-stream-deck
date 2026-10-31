import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexMicroRendererBridge } from "../src/codex-micro-renderer-bridge.js";

// Exercise the real snapshot path without sending agent, approval, or keycap
// actions. Persist only aggregate state, never task titles, IDs, or folder names.
const bridge = new CodexMicroRendererBridge((message) => console.log(message));
const samples: unknown[] = [];
let failure: string | undefined;
try {
  for (let sample = 0; sample < 3; sample += 1) {
    const snapshot = await bridge.refresh();
    assert.deepEqual(snapshot.slots.map((slot) => slot.id).sort(), [0, 1, 2, 3, 4, 5]);
    samples.push({
      slots: snapshot.slots.length,
      occupied: snapshot.slots.filter((slot) => Boolean(slot.threadKey)).length,
      selected: snapshot.slots.filter((slot) => slot.selected).length,
      statuses: snapshot.slots.map((slot) => slot.status),
      theme: snapshot.theme,
      usageAvailable: Boolean(snapshot.usage)
    });
    if (sample < 2) await delay(750);
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  bridge.close();
}
const report = {
  checkedAt: new Date().toISOString(),
  ready: !failure,
  samples,
  ...(failure ? { error: failure } : {})
};
await mkdir(resolve("outputs"), { recursive: true });
await writeFile(resolve("outputs/local-smoke.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
