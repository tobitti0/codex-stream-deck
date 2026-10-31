import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { encodeIpcFrame, IpcFrameDecoder, object, projectStatus, visualStatus, type ObjectValue, type StatusProjection } from "../local-ipc-protocol.js";
export { encodeIpcFrame, IpcFrameDecoder, projectStatus, visualStatus } from "../local-ipc-protocol.js";

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
              typeof params.conversationId === "string" && typeof params.hostId === "string" &&
              (!options.threadId || params.conversationId === options.threadId)) discover(params.conversationId, params.hostId);
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
