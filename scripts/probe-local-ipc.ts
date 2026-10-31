import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { probeLocalIpc } from "../src/experimental/local-ipc-probe.js";

const durationIndex = process.argv.indexOf("--duration-ms");
const threadIndex = process.argv.indexOf("--thread");
const report = await probeLocalIpc({
  durationMs: durationIndex < 0 ? 15_000 : Number(process.argv[durationIndex + 1]),
  threadId: threadIndex < 0 ? undefined : process.argv[threadIndex + 1]
});
await mkdir(resolve("outputs"), { recursive: true });
await writeFile(resolve("outputs/local-ipc-probe.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
if (!report.initialized || report.failure) process.exitCode = 1;
