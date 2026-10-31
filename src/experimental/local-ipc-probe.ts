import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value != null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : undefined;
const MAX_FRAME = 16 * 1024 * 1024;

export function encodeIpcFrame(message: ObjectValue): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME) throw new Error("IPC frame exceeds probe limit");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

export class IpcFrameDecoder {
  private buffered = Buffer.alloc(0);
  push(chunk: Buffer): ObjectValue[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: ObjectValue[] = [];
    while (this.buffered.length >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length === 0 || length > MAX_FRAME) throw new Error("Invalid IPC frame length");
      if (this.buffered.length < length + 4) break;
      const decoded = object(JSON.parse(this.buffered.subarray(4, length + 4).toString("utf8")));
      this.buffered = this.buffered.subarray(length + 4);
      if (!decoded) throw new Error("IPC message must be an object");
      messages.push(decoded);
    }
    return messages;
  }
}

export type StatusProjection = { revision: number; runtime: ObjectValue; unread: boolean };

function runtimeProjection(value: unknown): ObjectValue {
  const runtime = object(value);
  return {
    type: ["active", "idle", "systemError", "notLoaded"].includes(String(runtime?.type)) ? runtime?.type : undefined,
    activeFlags: Array.isArray(runtime?.activeFlags)
      ? runtime.activeFlags.filter((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput") : []
  };
}

export function projectStatus(previous: StatusProjection | undefined, change: unknown): StatusProjection | undefined {
  const value = object(change);
  if (!value || typeof value.revision !== "number") return undefined;
  if (value.type === "snapshot") {
    const state = object(value.conversationState);
    if (!state) return undefined;
    return { revision: value.revision, runtime: runtimeProjection(state.threadRuntimeStatus), unread: state.hasUnreadTurn === true };
  }
  if (value.type !== "patches" || !previous || value.baseRevision !== previous.revision || !Array.isArray(value.patches)) return undefined;
  const next = { ...previous, runtime: { ...previous.runtime }, revision: value.revision };
  for (const item of value.patches) {
    const patch = object(item);
    if (!patch || !Array.isArray(patch.path)) continue;
    const [field, nested] = patch.path;
    if (field === "hasUnreadTurn" && patch.path.length === 1) next.unread = patch.value === true;
    if (field !== "threadRuntimeStatus") continue;
    if (patch.path.length === 1) {
      next.runtime = runtimeProjection(patch.value);
    } else if (nested === "type" && patch.path.length === 2) next.runtime = runtimeProjection({ ...next.runtime, type: patch.value });
    else if (nested === "activeFlags") return undefined; // Ask for a fresh snapshot rather than guess array patches.
  }
  return next;
}

export function visualStatus(state: StatusProjection): string {
  switch (state.runtime.type) {
    case "active": {
      const flags = state.runtime.activeFlags;
      if (Array.isArray(flags) && flags.includes("waitingOnApproval")) return "awaiting-approval";
      if (Array.isArray(flags) && flags.includes("waitingOnUserInput")) return "awaiting-response";
      return "working";
    }
    case "idle": return state.unread ? "unread" : "idle";
    case "systemError": return "error";
    case "notLoaded": return "unavailable";
    default: return "unknown";
  }
}

export type IpcProbeReport = {
  initialized: boolean; usedCdp: false; ownerLookups: number; ownersFound: number;
  snapshots: number; patches: number; modelSettingsReadable: boolean;
  observedStatuses: string[]; messagesByMethod: Record<string, number>; failure?: string;
};

/** Isolated interoperability probe. No task actions or app/renderer modifications. */
export async function probeLocalIpc(options: { durationMs?: number; socketPath?: string; threadId?: string } = {}): Promise<IpcProbeReport> {
  const duration = options.durationMs ?? 15_000;
  if (!Number.isInteger(duration) || duration < 100 || duration > 30_000) throw new Error("Probe duration must be 100–30000 ms");
  const path = options.socketPath ?? join(homedir(), ".codex", "ipc", "ipc.sock");
  const [endpoint, directory] = await Promise.all([lstat(path), lstat(dirname(path))]);
  const uid = process.getuid?.();
  if (!endpoint.isSocket() || uid == null || endpoint.uid !== uid || directory.uid !== uid ||
      (endpoint.mode & 0o077) !== 0 || (directory.mode & 0o077) !== 0) throw new Error("Expected a private, current-user-owned IPC socket");
  const report: IpcProbeReport = { initialized: false, usedCdp: false, ownerLookups: 0, ownersFound: 0,
    snapshots: 0, patches: 0, modelSettingsReadable: false, observedStatuses: [], messagesByMethod: {} };
  const socket = createConnection(path);
  const decoder = new IpcFrameDecoder();
  const targets = new Map<string, { host: string; id: string; owner?: string; state?: StatusProjection }>();
  const requests = new Map<string, { method: string; target?: string }>();
  let clientId = "initializing-client", closing = false;
  const send = (packet: ObjectValue) => { if (socket.writable && !socket.destroyed) socket.write(encodeIpcFrame(packet)); };
  const request = (method: "initialize" | "thread-owner-discovery" | "thread-follower-read-model-settings", params: ObjectValue, target?: string) => {
    const requestId = randomUUID();
    requests.set(requestId, { method, target });
    send({ type: "request", requestId, sourceClientId: clientId, version: method === "initialize" ? 0 : 1,
      method, params, ...(target && targets.get(target)?.owner ? { targetClientId: targets.get(target)!.owner } : {}) });
  };
  const follow = (target: NonNullable<ReturnType<typeof targets.get>>, following: boolean) => {
    if (target.owner) send({ type: "broadcast", method: "thread-stream-following-changed", version: 1,
      sourceClientId: clientId, targetClientIds: [target.owner], params: { hostId: target.host, conversationId: target.id, following } });
  };
  const discover = (id: string, host: string) => {
    if (closing || targets.has(id) || targets.size >= 6 || host !== "local") return;
    targets.set(id, { id, host }); report.ownerLookups++;
    request("thread-owner-discovery", { hostId: host, conversationId: id }, id);
  };
  await new Promise<void>((resolve) => {
    let forceClose: NodeJS.Timeout | undefined;
    const finish = () => {
      if (closing) return;
      closing = true;
      for (const target of targets.values()) follow(target, false);
      socket.end();
      forceClose = setTimeout(() => socket.destroy(), 1_000);
    };
    const timeout = setTimeout(finish, duration);
    socket.on("connect", () => request("initialize", { clientType: "opendeck-status-probe" }));
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) {
          const params = object(message.params);
          if (message.type === "client-discovery-request") send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
          if (closing) continue;
          if (message.type === "response" && typeof message.requestId === "string") {
            const pending = requests.get(message.requestId);
            requests.delete(message.requestId);
            if (!pending) continue;
            const result = object(message.result);
            if (pending.method === "initialize") {
              report.initialized = message.resultType === "success" && typeof result?.clientId === "string";
              if (report.initialized) {
                clientId = result!.clientId as string;
                if (options.threadId) discover(options.threadId, "local");
              } else report.failure = "initialize-failed";
            } else if (pending.method === "thread-owner-discovery" && pending.target) {
              const target = targets.get(pending.target)!;
              if (message.resultType === "success" && typeof message.handledByClientId === "string") {
                target.owner = message.handledByClientId; report.ownersFound++; follow(target, true);
                request("thread-follower-read-model-settings", { conversationId: target.id }, pending.target);
              }
            } else if (pending.method === "thread-follower-read-model-settings" && message.resultType === "success") {
              report.modelSettingsReadable ||= object(result?.settings) != null;
            }
          }
          if (message.type !== "broadcast" || typeof message.method !== "string") continue;
          report.messagesByMethod[message.method] = (report.messagesByMethod[message.method] ?? 0) + 1;
          if (message.method === "thread-stream-following-changed" && message.version === 1 && params?.following === true &&
              typeof params.conversationId === "string" && typeof params.hostId === "string") discover(params.conversationId, params.hostId);
          if (message.method !== "thread-stream-state-changed" || message.version !== 11 || typeof params?.conversationId !== "string") continue;
          const target = targets.get(params.conversationId);
          if (!target || params.hostId !== target.host || message.sourceClientId !== target.owner) continue;
          const change = object(params.change);
          if (change?.type === "snapshot") report.snapshots++;
          if (change?.type === "patches") report.patches++;
          target.state = projectStatus(target.state, change);
          if (!target.state) follow(target, true);
          else {
            const status = visualStatus(target.state);
            if (!report.observedStatuses.includes(status)) report.observedStatuses.push(status);
          }
        }
      } catch { report.failure = "invalid-or-oversized-frame"; finish(); }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => { report.failure = error.code ?? "socket-error"; });
    socket.on("close", () => { clearTimeout(timeout); clearTimeout(forceClose); resolve(); });
  });
  return report;
}
