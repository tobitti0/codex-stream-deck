/** Mirrors the documented Micro hold / double-press gesture, without UI I/O. */
export type TalkGesture = { kind: "idle" } | { kind: "held"; since: number }
  | { kind: "waiting"; until: number } | { kind: "latched" };
export function talkTransition(state: TalkGesture, event: "down" | "up" | "timeout", now: number): {
  state: TalkGesture; effect?: "start" | "stop" | "latch"; deadline?: number;
} {
  if (state.kind === "idle") return event === "down" ? { state: { kind: "held", since: now }, effect: "start" } : { state };
  if (state.kind === "held") {
    if (event !== "up") return { state };
    const until = state.since + 350;
    return now >= until ? { state: { kind: "idle" }, effect: "stop" }
      : { state: { kind: "waiting", until }, deadline: until };
  }
  if (state.kind === "waiting") {
    if (now >= state.until || event === "timeout") return { state: { kind: "idle" }, effect: "stop" };
    return event === "down" ? { state: { kind: "latched" }, effect: "latch" } : { state, deadline: state.until };
  }
  return event === "down" ? { state: { kind: "idle" }, effect: "stop" } : { state };
}
