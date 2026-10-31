import { performance } from "node:perf_hooks";

/** Content-free counters. No sampling timer or persistent personal identifiers. */
export class RuntimeMetrics {
  private at = performance.now();
  private cpu = process.cpuUsage();
  private loop = performance.eventLoopUtilization();
  private images = 0;
  imageSent(): void { this.images++; }
  sample() {
    const now = performance.now();
    const seconds = Math.max(0.001, (now - this.at) / 1000);
    const cpu = process.cpuUsage();
    const loop = performance.eventLoopUtilization();
    const memory = process.memoryUsage();
    const result = { seconds: Math.round(seconds * 100) / 100,
      cpuPercentOfOneCore: Math.round(((cpu.user - this.cpu.user) + (cpu.system - this.cpu.system)) / (seconds * 10_000) * 100) / 100,
      rssMiB: Math.round(memory.rss / 1048576), heapMiB: Math.round(memory.heapUsed / 1048576),
      loopBusyPercent: Math.round(performance.eventLoopUtilization(loop, this.loop).utilization * 10000) / 100,
      imagesPerSecond: Math.round(this.images / seconds * 100) / 100 };
    this.at = now; this.cpu = cpu; this.loop = loop; this.images = 0;
    return result;
  }
}
