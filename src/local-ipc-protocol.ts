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

