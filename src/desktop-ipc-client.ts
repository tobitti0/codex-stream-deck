import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { displayText, LOCAL_THREAD_ID } from "./app-server-catalog.js";
import { encodeIpcFrame, IpcFrameDecoder, object, projectStatus, visualStatus, type ObjectValue, type StatusProjection } from "./local-ipc-protocol.js";

type Target = { id: string; owner?: string; state?: StatusProjection; title?: string; retryAt: number; followedAt: number; receivedAt: number; needsSnapshot: boolean; ownerProbeAt: number };
type Pending = { resolve: (value: ObjectValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export type DesktopIpcOptions = { socketPath?: string; retryMs?: number; timeoutMs?: number; resyncMs?: number;
  maxWindowBytes?: number; maxWindowProcessingMs?: number; cooldownMs?: number };

export class DesktopIpcClient {
  private socket?: Socket;
  private clientId?: string;
  private generation = 0;
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private readonly targets = new Map<string, Target>();
  private readonly pending = new Map<string, Pending>();
  private coolingUntil = 0;
  private windowAt = 0;
  private windowBytes = 0;
  private windowProcessingMs = 0;
  private readonly metrics = { receivedBytes: 0, frames: 0, largestFrameBytes: 0, processingMs: 0, visibleChanges: 0, snapshotsRequested: 0, budgetStops: 0 };
  private readonly path: string;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private readonly resyncMs: number;
  private readonly maxWindowBytes: number;
  private readonly maxWindowProcessingMs: number;
  private readonly cooldownMs: number;

  constructor(private readonly changed: () => void = () => {}, options: DesktopIpcOptions = {}) {
    this.path = options.socketPath ?? join(homedir(), ".codex", "ipc", "ipc.sock");
    this.retryMs = options.retryMs ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.resyncMs = options.resyncMs ?? 0;
    this.maxWindowBytes = options.maxWindowBytes ?? 32 * 1024 * 1024;
    this.maxWindowProcessingMs = options.maxWindowProcessingMs ?? 1_000;
    this.cooldownMs = options.cooldownMs ?? 60_000;
  }
  start(): void { if (!this.stopped) return; this.stopped = false; void this.connect(++this.generation); }
  close(): void {
    this.stopped = true; ++this.generation; clearTimeout(this.timer);
    for (const target of this.targets.values()) this.follow(target, false);
    this.socket?.destroy(); this.socket = undefined; this.reset();
  }
  get connected(): boolean { return this.clientId != null; }
  get throttled(): boolean { return Date.now() < this.coolingUntil; }
  diagnostics() { return { ...this.metrics, connected: this.connected, throttled: this.throttled }; }
  current(id: string): { state?: StatusProjection; title?: string } | undefined { return this.targets.get(id); }
  setTargets(ids: string[]): void {
    const next = new Set(ids.filter((id) => LOCAL_THREAD_ID.test(id)).slice(0, 6));
    for (const [id, target] of this.targets) if (!next.has(id)) { this.follow(target, false); this.targets.delete(id); }
    for (const id of next) if (!this.targets.has(id)) {
      const target: Target = { id, retryAt: 0, followedAt: 0, receivedAt: 0, needsSnapshot: false, ownerProbeAt: 0 };
      this.targets.set(id, target);
      if (this.clientId) this.discover(target);
    }
  }
  async readModelSettings(id: string): Promise<ObjectValue> {
    const target = this.targets.get(id);
    if (!target?.owner || !target.state) throw new Error("No live IPC owner for this chat.");
    const result = object((await this.request("thread-follower-read-model-settings", { conversationId: id }, 1, target.owner)).result);
    const settings = object(result?.settings);
    if (!settings) throw new Error("IPC model settings are unavailable.");
    return settings;
  }

  private reset(): void {
    this.clientId = undefined;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Desktop IPC disconnected.")); }
    this.pending.clear();
    for (const target of this.targets.values()) { target.owner = undefined; target.state = undefined; target.retryAt = 0; target.needsSnapshot = false; }
    this.changed();
  }
  private async connect(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    if (this.throttled) { this.schedule(generation, true); return; }
    try {
      const [endpoint, directory] = await Promise.all([lstat(this.path), lstat(dirname(this.path))]);
      const uid = process.getuid?.();
      if (!endpoint.isSocket() || !directory.isDirectory() || uid == null || endpoint.uid !== uid || directory.uid !== uid ||
          (endpoint.mode & 0o077) !== 0 || (directory.mode & 0o077) !== 0) throw new Error("Expected a private IPC socket.");
      if (this.stopped || generation !== this.generation) return;
      this.windowAt = performance.now(); this.windowBytes = 0; this.windowProcessingMs = 0;
      const socket = createConnection(this.path); this.socket = socket;
      const decoder = new IpcFrameDecoder();
      const handshake = setTimeout(() => socket.destroy(), this.timeoutMs);
      socket.on("connect", () => {
        void this.request("initialize", { clientType: "opendeck-local-status" }, 0).then((message) => {
          if (this.socket !== socket || this.stopped) return;
          const result = object(message.result);
          if (typeof result?.clientId !== "string") { socket.destroy(); return; }
          this.clientId = result.clientId; clearTimeout(handshake);
          for (const target of this.targets.values()) this.discover(target);
          this.changed();
        }).catch(() => socket.destroy());
      });
      socket.on("data", (chunk: Buffer) => {
        if (this.throttled) return;
        const started = performance.now();
        if (started - this.windowAt >= 10_000) { this.windowAt = started; this.windowBytes = 0; this.windowProcessingMs = 0; }
        this.metrics.receivedBytes += chunk.length; this.windowBytes += chunk.length;
        if (this.windowBytes > this.maxWindowBytes) { this.exceedBudget(socket); return; }
        try {
          for (const message of decoder.push(chunk)) { this.metrics.frames++; this.receive(message); }
          this.metrics.largestFrameBytes = Math.max(this.metrics.largestFrameBytes, decoder.largestFrame);
        }
        catch { socket.destroy(); }
        const elapsed = performance.now() - started;
        this.metrics.processingMs += elapsed; this.windowProcessingMs += elapsed;
        if (this.windowProcessingMs > this.maxWindowProcessingMs) this.exceedBudget(socket);
      });
      socket.on("error", () => {});
      socket.on("close", () => {
        clearTimeout(handshake);
        if (this.socket !== socket) return;
        this.socket = undefined; this.reset(); this.schedule(generation, true);
      });
      this.schedule(generation, false);
    } catch { this.schedule(generation, true); }
  }
  private schedule(generation: number, reconnect: boolean): void {
    clearTimeout(this.timer);
    if (this.stopped || generation !== this.generation) return;
    this.timer = setTimeout(() => {
      if (reconnect) { void this.connect(generation); return; }
      if (this.clientId) for (const target of this.targets.values()) {
        const now = Date.now();
        if (!target.owner && target.retryAt <= now) this.discover(target);
        else if (target.owner && target.followedAt > target.receivedAt && now - target.followedAt > this.timeoutMs) {
          target.owner = undefined; target.state = undefined; target.retryAt = now + this.retryMs; this.changed();
        } else if (target.owner && (this.resyncMs > 0 && now - target.followedAt >= this.resyncMs || target.needsSnapshot && now - target.followedAt >= 250)) this.follow(target, true);
        else if (target.owner && now >= target.ownerProbeAt) this.discover(target);
      }
      this.schedule(generation, false);
    }, reconnect ? Math.max(this.retryMs, this.coolingUntil - Date.now()) : Math.min(1_000, this.retryMs));
  }
  private exceedBudget(socket: Socket): void {
    if (this.throttled) return;
    this.coolingUntil = Date.now() + this.cooldownMs; this.metrics.budgetStops++;
    for (const target of this.targets.values()) this.follow(target, false);
    socket.end(); socket.destroySoon();
  }
  private send(packet: ObjectValue): void {
    if (this.socket?.writable && !this.socket.destroyed) this.socket.write(encodeIpcFrame(packet));
  }
  private request(method: string, params: ObjectValue, version = 1, targetClientId?: string): Promise<ObjectValue> {
    if (!this.socket?.writable) return Promise.reject(new Error("Desktop IPC is disconnected."));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("Desktop IPC request timed out.")); }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ type: "request", requestId, sourceClientId: this.clientId ?? "initializing-client", version, method, params,
        ...(targetClientId ? { targetClientId } : {}) });
    });
  }
  private discover(target: Target): void {
    target.retryAt = Date.now() + Math.max(this.timeoutMs, this.retryMs);
    target.ownerProbeAt = Date.now() + 60_000;
    const socket = this.socket;
    void this.request("thread-owner-discovery", { hostId: "local", conversationId: target.id }).then((message) => {
      if (this.socket !== socket || this.targets.get(target.id) !== target || typeof message.handledByClientId !== "string") return;
      if (target.owner === message.handledByClientId) return;
      target.owner = message.handledByClientId; target.state = undefined; this.follow(target, true);
    }).catch(() => {
      if (this.socket !== socket || this.targets.get(target.id) !== target) return;
      if (target.owner) { target.owner = undefined; target.state = undefined; this.changed(); }
    });
  }
  private broadcast(method: string, params: ObjectValue, owner?: string): void {
    this.send({ type: "broadcast", method, version: 1, sourceClientId: this.clientId,
      ...(owner ? { targetClientIds: [owner] } : {}), params });
  }
  private follow(target: Target, following: boolean): void {
    if (!target.owner || !this.clientId) return;
    if (following) { target.followedAt = Date.now(); target.needsSnapshot = false; this.metrics.snapshotsRequested++; }
    this.broadcast("thread-stream-following-changed", { hostId: "local", conversationId: target.id, following }, target.owner);
  }
  private receive(message: ObjectValue): void {
    if (message.type === "client-discovery-request") {
      this.send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } }); return;
    }
    if (message.type === "response" && typeof message.requestId === "string") {
      const pending = this.pending.get(message.requestId); if (!pending) return;
      this.pending.delete(message.requestId); clearTimeout(pending.timer);
      if (message.resultType === "success") pending.resolve(message); else pending.reject(new Error("Desktop IPC request unavailable."));
      return;
    }
    // An initial renderer announcement may precede the initialize response.
    if (message.type !== "broadcast") return;
    const params = object(message.params);
    if (message.method === "ipc-connection-reset") { this.socket?.destroy(); return; }
    if (message.method === "client-status-changed" && params?.status === "disconnected") {
      for (const target of this.targets.values()) if (target.owner === params.clientId) { target.owner = undefined; target.state = undefined; target.retryAt = 0; }
      this.changed(); return;
    }
    if (params?.hostId !== "local" || typeof params.conversationId !== "string" || !LOCAL_THREAD_ID.test(params.conversationId)) return;
    if (message.method !== "thread-stream-state-changed" || message.version !== 11) return;
    const target = this.targets.get(params.conversationId);
    if (!target || message.sourceClientId !== target.owner) return;
    const change = object(params.change);
    const previous = target.state ? visualStatus(target.state) : undefined;
    const previousTitle = target.title;
    target.state = projectStatus(target.state, change);
    if (!target.state) { target.needsSnapshot = true; }
    else {
      target.receivedAt = Date.now();
      if (change?.type === "snapshot") target.title = displayText(object(change.conversationState)?.title);
      if (Array.isArray(change?.patches)) for (const item of change.patches) {
        const patch = object(item);
        if (Array.isArray(patch?.path) && patch.path.length === 1 && patch.path[0] === "title") target.title = displayText(patch.value);
      }
    }
    if (previous !== (target.state ? visualStatus(target.state) : undefined) || previousTitle !== target.title) {
      this.metrics.visibleChanges++; this.changed();
    }
  }
}
