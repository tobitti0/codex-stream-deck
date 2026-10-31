import { execFile } from "node:child_process";
import { cpus } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { LocalCodexBridge } from "../src/local-codex-bridge.js";
import { RuntimeMetrics } from "../src/runtime-metrics.js";

// A bounded, read-only off/on/off measurement. Never opens any window or mic,
// changes settings, presses keys, or keeps the IPC connection after completion.
const execFileAsync = promisify(execFile);
const metrics = new RuntimeMetrics();
let notifications = 0;
const bridge = new LocalCodexBridge(() => {}, () => { notifications++; });
const report: Record<string, unknown> = { usedCdp: false, usedUi: false, usedMicrophone: false };
const samples: Record<string, unknown>[] = [];
const totalCpu = () => cpus().reduce((sum, core) => ({ idle: sum.idle + core.times.idle,
  total: sum.total + Object.values(core.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });
const timeMillis = (value: string) => value.split(":").reverse().reduce((sum, part, n) => sum + Number(part) * 1000 * 60 ** n, 0);
let previousHost = totalCpu();
let previousProcesses = new Map<number, number>();
let previousAt = performance.now();
let refresh: NodeJS.Timeout | undefined;

async function sample(phase: string) {
  const now = performance.now();
  const host = totalCpu();
  const hostPercent = 100 * (1 - (host.idle - previousHost.idle) / Math.max(1, host.total - previousHost.total));
  const { stdout } = await execFileAsync("/bin/ps", ["-A", "-o", "pid=,ppid=,time=,rss=,comm="], { maxBuffer: 1024 * 1024 });
  const processes = new Map<number, number>();
  const groups: Record<string, { cpuPercent: number; rssMiB: number }> = {};
  const rows = stdout.trim().split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d:.]+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: +match[1]!, parent: +match[2]!, cpu: timeMillis(match[3]!), rss: +match[4]!, command: match[5]! }] : [];
  });
  const own = new Set([process.pid]);
  for (let n = 0; n < 3; n++) for (const row of rows) if (own.has(row.parent)) own.add(row.pid);
  for (const row of rows) {
    processes.set(row.pid, row.cpu);
    const group = own.has(row.pid) ? "probe-and-catalog" : row.command.endsWith("WindowServer") ? "window-server"
      : /Raft\.exe$/.test(row.command) ? "raft" : row.command.includes("/ChatGPT.app/") ? "chatgpt" : undefined;
    if (!group) continue;
    const summary = groups[group] ??= { cpuPercent: 0, rssMiB: 0 };
    const prior = previousProcesses.get(row.pid);
    if (prior != null) summary.cpuPercent += Math.max(0, row.cpu - prior) / Math.max(1, now - previousAt) * 100;
    summary.rssMiB += row.rss / 1024;
  }
  for (const group of Object.values(groups)) { group.cpuPercent = Math.round(group.cpuPercent * 100) / 100; group.rssMiB = Math.round(group.rssMiB); }
  previousHost = host; previousAt = now; previousProcesses = processes;
  const ownUsage = metrics.sample();
  const result = { phase, hostCpuPercent: Math.round(hostPercent * 100) / 100, ...ownUsage, groups,
    ipc: bridge.ipc.diagnostics(), notifications };
  samples.push(result);
  return result;
}

try {
  await sample("warmup");
  for (const [phase, seconds] of [["off-before", 8], ["on", 20], ["off-after", 8]] as const) {
    console.log(`Load measurement: ${phase} (${seconds}s)`);
    if (phase === "on") {
      bridge.start();
      let pending = false;
      refresh = setInterval(() => {
        if (pending) return; pending = true;
        void bridge.refresh().catch(() => {}).finally(() => { pending = false; });
      }, 1200);
    }
    if (phase === "off-after") { clearInterval(refresh); bridge.close(); }
    let high = 0;
    for (let elapsed = 0; elapsed < seconds; elapsed += 2) {
      await delay(2000);
      const point = await sample(phase);
      high = point.cpuPercentOfOneCore > 20 || point.hostCpuPercent > 85 || point.rssMiB > 512 ? high + 1 : 0;
      if (phase === "on" && (high >= 2 || point.ipc.budgetStops > 0)) throw new Error("Measurement stopped at its load budget; IPC disconnected.");
    }
  }
  report.completed = true;
} catch (error) { report.completed = false; report.reason = String(error); }
finally {
  clearInterval(refresh); bridge.close(); report.samples = samples;
  await mkdir("outputs", { recursive: true });
  await writeFile("outputs/normal-load-measurement.json", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const summary = ["off-before", "on", "off-after"].map((phase) => {
    const points = samples.filter((p) => p.phase === phase);
    const mean = (key: string) => points.length ? Math.round(points.reduce((sum, p) => sum + Number(p[key]), 0) / points.length * 100) / 100 : undefined;
    return { phase, samples: points.length, meanProbeCpuPercentOfOneCore: mean("cpuPercentOfOneCore"), meanHostCpuPercent: mean("hostCpuPercent"), maxRssMiB: Math.max(0, ...points.map((p) => Number(p.rssMiB))) };
  });
  console.log(JSON.stringify({ completed: report.completed, reason: report.reason, summary, ipc: bridge.ipc.diagnostics(), notifications }, null, 2));
}
