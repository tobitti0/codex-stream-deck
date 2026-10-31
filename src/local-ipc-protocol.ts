export type ObjectValue = Record<string, unknown>;
export const object = (value: unknown): ObjectValue | undefined =>
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
  private readonly header = Buffer.allocUnsafe(4);
  private headerUsed = 0;
  private body?: Buffer;
  private bodyUsed = 0;
  allocatedBytes = 0;
  frames = 0;
  largestFrame = 0;
  push(chunk: Buffer): ObjectValue[] {
    const messages: ObjectValue[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.body) {
        const count = Math.min(4 - this.headerUsed, chunk.length - offset);
        chunk.copy(this.header, this.headerUsed, offset, offset + count); offset += count; this.headerUsed += count;
        if (this.headerUsed < 4) break;
        const length = this.header.readUInt32LE(0);
        if (length === 0 || length > MAX_FRAME) throw new Error("Invalid IPC frame length");
        // Allocate each frame only once. Repeated Buffer.concat of a fragmented
        // multi-MB snapshot otherwise copies the growing body quadratically.
        this.body = Buffer.allocUnsafe(length); this.allocatedBytes += length;
        this.largestFrame = Math.max(this.largestFrame, length); this.bodyUsed = 0;
      }
      const count = Math.min(this.body.length - this.bodyUsed, chunk.length - offset);
      chunk.copy(this.body, this.bodyUsed, offset, offset + count); offset += count; this.bodyUsed += count;
      if (this.bodyUsed < this.body.length) continue;
      const body = this.body; this.body = undefined; this.headerUsed = 0; this.bodyUsed = 0;
      const decoded = object(JSON.parse(body.toString("utf8")));
      if (!decoded) throw new Error("IPC message must be an object");
      this.frames++; messages.push(decoded);
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

