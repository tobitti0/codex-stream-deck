import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LocalCodexBridge } from "../src/local-codex-bridge.js";

// Read-only end-to-end test: no CDP, selection changes, approvals, settings
// mutations, task creation, or messages. The report contains aggregate data only.
const bridge = new LocalCodexBridge(console.log);
const report: Record<string, unknown> = { usedCdp: false, samples: [] };
const samples: unknown[] = [];
bridge.start();
try {
  const deadline = Date.now() + 12_000;
  let connected = false;
  while (Date.now() < deadline) {
    try { await bridge.refresh(); connected = true; break; } catch { await delay(150); }
  }
  assert(connected, "Normal-launch IPC/catalog did not become available.");
  await delay(750);
  for (let i = 0; i < 3; i++) {
    const snapshot = await bridge.refresh();
    assert.equal(snapshot.statusSource, "local-ipc");
    assert.deepEqual(snapshot.slots.map((slot) => slot.id), [0, 1, 2, 3, 4, 5]);
    samples.push({ occupied: snapshot.slots.filter((slot) => slot.threadKey).length,
      statuses: snapshot.slots.map((slot) => slot.status), origins: snapshot.slots.map((slot) => slot.statusOrigin),
      usage: snapshot.usage?.windows.map(({ kind, remainingPercent }) => ({ kind, remainingPercent })),
      microphoneKeycap: snapshot.layout.slots.ACT10_ACT11?.keycapId });
    await delay(350);
  }
  report.capabilities = await bridge.checkReadCapabilities();
  report.ready = true;
} catch (error) {
  report.ready = false; report.failure = String(error); process.exitCode = 1;
} finally {
  bridge.close(); report.samples = samples;
  await mkdir(resolve("outputs"), { recursive: true });
  await writeFile(resolve("outputs/normal-launch-smoke.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
