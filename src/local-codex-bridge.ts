import { AppServerCatalog, type CatalogThread, LOCAL_THREAD_ID } from "./app-server-catalog.js";
import { CodexMicroRendererBridge } from "./codex-micro-renderer-bridge.js";
import { openCodexThread } from "./codex-open.js";
import { DesktopIpcClient, type DesktopIpcOptions } from "./desktop-ipc-client.js";
import { visualStatus } from "./local-ipc-protocol.js";
import type { MicroActionSlot, MicroDirection, MicroSnapshot, ReasoningAdjustment, UsageSnapshot } from "./types.js";
import type { OfficialKeycapId } from "./keycaps.js";
import { MacOsDictation, type DictationDriver } from "./macos-dictation.js";

export type LocalBridgeOptions = DesktopIpcOptions & { cliPath?: string; platform?: string; native?: CodexMicroRendererBridge; preferIpc?: boolean;
  catalog?: Pick<AppServerCatalog, "recent" | "usage" | "close">; dictationDriver?: DictationDriver };

/** Normal-launch recent local chats, with the existing native bridge kept for launcher sessions. */
export class LocalCodexBridge {
  private readonly native: CodexMicroRendererBridge;
  readonly ipc: DesktopIpcClient;
  private readonly catalog: Pick<AppServerCatalog, "recent" | "usage" | "close">;
  private readonly enabled: boolean;
  private readonly dictation: MacOsDictation;
  private preferIpc: boolean;
  private threads: CatalogThread[] = [];
  private catalogAt = 0;
  private nextCatalogAttempt = 0;
  private catalogPending?: Promise<void>;
  private usage?: UsageSnapshot;
  private nextUsageAttempt = 0;
  private usagePending?: Promise<void>;
  private currentSource?: "native" | "local-ipc";
  private stopped = false;
  private changedTimer?: NodeJS.Timeout;
  private reportedBudgetStops = 0;
  constructor(private readonly log: (message: string) => void, private readonly changed: () => void = () => {}, options: LocalBridgeOptions = {}) {
    this.native = options.native ?? new CodexMicroRendererBridge(log);
    this.enabled = (options.platform ?? process.platform) === "darwin";
    this.preferIpc = options.preferIpc !== false;
    this.catalog = options.catalog ?? new AppServerCatalog(options.cliPath);
    this.ipc = new DesktopIpcClient(() => this.notify(), options);
    this.dictation = new MacOsDictation(() => this.notify(), log, options.dictationDriver);
  }
  start(): void { if (this.enabled) this.ipc.start(); }
  setConnectionMode(mode: "local-ipc" | "native"): void {
    if (this.preferIpc && mode === "native") this.dictation.cancel();
    this.preferIpc = mode === "local-ipc";
    if (!this.preferIpc) this.ipc.setTargets([]);
  }
  close(): void {
    this.stopped = true; clearTimeout(this.changedTimer); this.ipc.close(); this.catalog.close(); this.native.close(); this.dictation.close();
  }
  async refresh(): Promise<MicroSnapshot> {
    if (this.stopped) throw new Error("Local bridge stopped.");
    if (!this.enabled || !this.preferIpc) {
      const snapshot = await this.native.refresh(); this.setSource("native"); return snapshot;
    }
    const stops = this.ipc.diagnostics().budgetStops;
    if (stops > this.reportedBudgetStops) {
      this.reportedBudgetStops = stops;
      this.log("IPC load budget exceeded: using history while the connection cools down for 60 seconds.");
    }
    if (!this.ipc.connected && !this.ipc.throttled) throw new Error("Waiting for the normally launched ChatGPT desktop IPC.");
    // Usage has its own cadence: a slow account request must not block live
    // status or recent-chat discovery. Never keep a failed read indefinitely.
    if (Date.now() >= this.nextUsageAttempt && !this.usagePending) {
      this.nextUsageAttempt = Date.now() + 30_000;
      const pending = this.catalog.usage().then((usage) => { if (!this.stopped) this.usage = usage; });
      this.usagePending = pending;
      void pending.catch(() => this.log("Account usage read unavailable; cached values expire after 60 seconds."))
        .finally(() => { if (this.usagePending === pending) this.usagePending = undefined; this.notify(); });
    }
    if (Date.now() >= this.nextCatalogAttempt && !this.catalogPending) {
      this.nextCatalogAttempt = Date.now() + 10_000;
      const pending = (async () => {
        const live = new Set(this.threads.filter((t) => this.ipc.current(t.id)?.state != null).map((t) => t.id));
        const threads = await this.catalog.recent(live);
        if (this.stopped) throw new Error("Local bridge stopped.");
        this.threads = threads; this.catalogAt = Date.now();
        if (this.preferIpc) this.ipc.setTargets(threads.map((t) => t.id));
      })();
      this.catalogPending = pending;
      void pending.catch(() => {}).finally(() => { if (this.catalogPending === pending) this.catalogPending = undefined; this.notify(); });
    }
    // Initial discovery may wait for the catalog; later history I/O must not
    // hold up live IPC patches and animation of the existing six cards.
    if (!this.catalogAt && this.catalogPending) await this.catalogPending;
    if (!this.catalogAt || Date.now() - this.catalogAt > 30_000) throw new Error("Recent chat catalog is unavailable or stale.");
    this.setSource("local-ipc");
    return { ...buildLocalSnapshot(this.threads, this.ipc,
      this.usage && Date.now() - this.usage.observedAt < 60_000 ? this.usage : undefined), microphoneState: this.dictation.state };
  }
  async checkReadCapabilities(): Promise<{ modelSettingsReadable: boolean; accountUsageReadable: boolean }> {
    const live = this.threads.find((t) => this.ipc.current(t.id)?.state != null);
    const [modelSettingsReadable, accountUsageReadable] = await Promise.all([
      live ? this.ipc.readModelSettings(live.id).then(() => true, () => false) : Promise.resolve(false),
      this.catalog.usage().then((usage) => usage != null, () => false)
    ]);
    return { modelSettingsReadable, accountUsageReadable };
  }
  async sendAgent(_slot: number, act: 0 | 1, threadKey?: string): Promise<void> {
    if (!this.enabled || !this.preferIpc) return this.native.sendAgent(_slot, act, threadKey);
    const id = threadKey?.replace(/^local:/, "");
    if (!id || !LOCAL_THREAD_ID.test(id)) throw new Error("The agent has no valid local chat identity.");
    if (act === 0) return;
    if (!this.ipc.connected) throw new Error("ChatGPT IPC is disconnected.");
    await openCodexThread(id);
    // URL delivery is acknowledged by Launch Services; idle tab selection is not
    // observable on the streaming IPC bus. Do not confuse following with focus.
  }
  private requireNative(): void {
    if (this.enabled && this.preferIpc) throw new Error("This key is not yet supported by the normal-launch bridge. Use the launcher for native Micro actions.");
  }
  async sendAction(slot: MicroActionSlot, act: 0 | 1): Promise<void> {
    if (this.enabled && this.preferIpc && slot === "ACT10_ACT11") return this.dictation.key(act);
    this.requireNative(); return this.native.sendAction(slot, act);
  }
  async sendJoystick(direction: MicroDirection, distance: 0 | 1): Promise<void> { this.requireNative(); return this.native.sendJoystick(direction, distance); }
  async sendEncoder(act: 0 | 1): Promise<void> { this.requireNative(); return this.native.sendEncoder(act); }
  async adjustReasoning(direction: ReasoningAdjustment): Promise<void> { this.requireNative(); return this.native.adjustReasoning(direction); }
  async runKeycap(key: OfficialKeycapId): Promise<void> {
    if (this.enabled && this.preferIpc && key === "NEW") return openCodexThread("new");
    this.requireNative(); return this.native.runKeycap(key);
  }
  async consumeRateLimitReset(): Promise<void> { this.requireNative(); return this.native.consumeRateLimitReset(); }
  private setSource(source: "native" | "local-ipc"): void {
    if (this.currentSource !== source) this.log(source === "native" ? "Local status source: native Micro."
      : "Local status source: recent local chats via app-server catalog and desktop IPC.");
    this.currentSource = source;
  }
  private notify(): void {
    if (this.stopped || this.changedTimer) return;
    this.changedTimer = setTimeout(() => { this.changedTimer = undefined; if (!this.stopped) this.changed(); }, 250);
  }
}

export function buildLocalSnapshot(threads: CatalogThread[], ipc: Pick<DesktopIpcClient, "current">, usage?: UsageSnapshot): MicroSnapshot {
  return {
    statusSource: "local-ipc",
    ...(usage ? { usage } : {}),
    slots: Array.from({ length: 6 }, (_, id) => {
      const thread = threads[id];
      if (!thread) return { id, threadKey: null, title: null, status: "off", selected: false };
      const live = ipc.current(thread.id);
      return { id, threadKey: `local:${thread.id}`, title: live?.title ?? thread.title,
        status: live?.state ? visualStatus(live.state) : thread.historyStatus,
        statusOrigin: live?.state ? "ipc" as const : "history" as const,
        selected: false, activityAt: thread.activityAt, projectName: thread.projectName };
    }),
    layout: { version: 1, slots: { ACT06: { keycapId: "FAST" }, ACT07: { keycapId: "APPR" }, ACT08: { keycapId: "REJ" },
      ACT09: { keycapId: "SPLIT" }, ACT10_ACT11: { keycapId: "MIC" }, ACT12: { keycapId: "CODEX" } },
      analogStick: { up: {}, right: {}, down: {}, left: {} } },
    agentSource: "recent", lightingAutoOff: "unknown", theme: "dark"
  };
}
