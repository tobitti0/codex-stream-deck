import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename } from "node:path";
import { object } from "./local-ipc-protocol.js";
import { usageWindowKind } from "./usage.js";
import type { UsageSnapshot, UsageWindow } from "./types.js";

export const LOCAL_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type CatalogThread = { id: string; title: string; activityAt: number; projectName?: string; historyStatus: string };
export function displayText(value: unknown, limit = 240): string | undefined {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, limit) || undefined : undefined;
}
export function epoch(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value < 100_000_000_000 ? value * 1000 : value : 0;
}
export function parseCatalog(value: unknown): CatalogThread[] {
  const data = object(value)?.data;
  if (!Array.isArray(data)) throw new Error("Unexpected app-server thread catalog.");
  const seen = new Set<string>();
  return data.flatMap((entry) => {
    const t = object(entry);
    if (typeof t?.id !== "string" || !LOCAL_THREAD_ID.test(t.id) || seen.has(t.id) || t.parentThreadId || t.ephemeral === true) return [];
    seen.add(t.id);
    return [{ id: t.id, title: displayText(t.name) ?? displayText(t.preview) ?? "New chat",
      activityAt: epoch(t.recencyAt) || epoch(t.updatedAt) || epoch(t.createdAt), historyStatus: "unavailable",
      ...(typeof t.cwd === "string" ? { projectName: displayText(basename(t.cwd), 80) } : {}) }];
  }).sort((a, b) => b.activityAt - a.activityAt).slice(0, 6);
}

export function parseAccountUsage(value: unknown, now = Date.now()): UsageSnapshot | undefined {
  const result = object(value);
  // Use the primary account rateLimits projection, not an arbitrary limit/account scope.
  const limits = object(result?.rateLimits);
  if (!limits) return undefined;
  const windows: UsageWindow[] = [];
  for (const key of ["primary", "secondary"]) {
    const window = object(limits[key]);
    if (typeof window?.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) continue;
    const mins = typeof window.windowDurationMins === "number" && window.windowDurationMins > 0 ? window.windowDurationMins : null;
    windows.push({ id: key, kind: usageWindowKind(mins), usedPercent: window.usedPercent, remainingPercent: 100 - window.usedPercent,
      windowDurationMins: mins, resetsAt: epoch(window.resetsAt) || null });
  }
  if (!windows.length) return undefined;
  return { windows, observedAt: now, resetCreditsAvailable: null, resetCreditsApplicable: null };
}

/** Isolated read-only app-server client: never resumes a thread or sends a turn. */
export class AppServerCatalog {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private nextId = 0;
  private stopped = false;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly executable?: string, private readonly timeoutMs = 8_000) {}

  async recent(skipHistoryFor: ReadonlySet<string> = new Set()): Promise<CatalogThread[]> {
    await this.start();
    const value = await this.request("thread/list", { limit: 12, sortKey: "recency_at", sortDirection: "desc",
      archived: false, useStateDbOnly: true, sourceKinds: ["cli", "vscode", "appServer"] });
    const threads = parseCatalog(value);
    await Promise.all(threads.map(async (thread) => {
      if (skipHistoryFor.has(thread.id)) return;
      try {
        const page = object(await this.request("thread/turns/list", {
          threadId: thread.id, limit: 1, sortDirection: "desc", itemsView: "notLoaded"
        }));
        const turn = Array.isArray(page?.data) ? object(page.data[0]) : undefined;
        // History does not establish unread state or a live in-progress state.
        thread.historyStatus = !turn || ["completed", "interrupted"].includes(String(turn.status)) ? "idle"
          : turn.status === "failed" ? "error" : "unavailable";
      } catch { thread.historyStatus = "unavailable"; }
    }));
    return threads;
  }
  async usage(): Promise<UsageSnapshot | undefined> {
    await this.start(); return parseAccountUsage(await this.request("account/rateLimits/read", {}));
  }

  close(): void {
    this.stopped = true;
    this.fail(new Error("Catalog client stopped."));
    const child = this.child;
    this.child = undefined;
    child?.stdin.end();
    if (child) { const timer = setTimeout(() => child.kill("SIGTERM"), 500); timer.unref(); }
  }

  private async start(): Promise<void> {
    if (this.stopped) throw new Error("Catalog client stopped.");
    if (this.starting) return this.starting;
    if (this.child && this.child.exitCode == null && !this.child.killed) return;
    const pending = this.startOnce();
    this.starting = pending;
    try { await pending; } finally { if (this.starting === pending) this.starting = undefined; }
  }

  private async startOnce(): Promise<void> {
    let executable = this.executable ?? process.env.CODEX_DECK_CLI_PATH;
    if (!executable) for (const candidate of [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex"
    ]) { try { await access(candidate, constants.X_OK); executable = candidate; break; } catch {} }
    if (!executable) throw new Error("Bundled Codex app-server executable not found. Set CODEX_DECK_CLI_PATH.");
    if (this.stopped) throw new Error("Catalog client stopped.");
    const child = spawn(executable, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stderr.resume(); // Backend diagnostics can contain personal data. Do not relay or persist them.
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { child.kill(); this.fail(new Error("Catalog frame limit exceeded.")); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const m = object(JSON.parse(line));
          if (m?.method != null) continue;
          const p = typeof m?.id === "number" ? this.pending.get(m.id) : undefined;
          if (!p) continue;
          this.pending.delete(m!.id as number); clearTimeout(p.timer);
          if (m!.error) p.reject(new Error("App-server catalog request failed.")); else p.resolve(m!.result);
        } catch { /* Ignore unsolicited non-response diagnostics. */ }
      }
    });
    const ended = () => { if (this.child === child) { this.child = undefined; this.fail(new Error("App-server catalog disconnected.")); } };
    child.on("error", ended); child.on("close", ended);
    child.stdin.on("error", ended);
    try {
      await this.request("initialize", { clientInfo: { name: "codex_deck_catalog", version: "0.7.0" }, capabilities: { experimentalApi: true } });
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    } catch (error) { child.kill(); if (this.child === child) this.child = undefined; throw error; }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) return Promise.reject(new Error("Catalog is disconnected."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Catalog ${method} timed out.`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error && this.pending.delete(id)) { clearTimeout(timer); reject(new Error("Catalog write failed.")); }
      });
    });
  }
  private fail(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
}
