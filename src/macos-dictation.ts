import { execFile } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { talkTransition, type TalkGesture } from "./push-to-talk.js";

const execFileAsync = promisify(execFile);
const HELPER_APP = fileURLToPath(new URL("./Codex Deck Controls.app", import.meta.url));
async function prepareHelper(appPath: string): Promise<void> {
  // OpenDeck's ZIP installer can drop executable bits. The helper is our own
  // bundled binary, so restore its mode before asking Launch Services to run it.
  await chmod(join(appPath, "Contents/MacOS/CodexDeckControls"), 0o755);
}
let setupOpening: Promise<void> | undefined;
export async function openMicrophoneSetup(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Normal-launch microphone setup is available on macOS.");
  if (setupOpening) return setupOpening;
  const pending = (async () => {
    await prepareHelper(HELPER_APP);
    await execFileAsync("/usr/bin/open", ["-n", "-a", HELPER_APP, "--args", "--setup"], { timeout: 5_000 });
  })();
  setupOpening = pending;
  try { await pending; } finally { if (setupOpening === pending) setupOpening = undefined; }
}
export type DictationState = "idle" | "starting" | "recording" | "hands-free" | "stopping" | "permission-required" | "error";
export type DictationCommand = "start" | "stop" | "latch";
export interface DictationDriver {
  command(command: DictationCommand, session: string): Promise<void>;
  close(): void;
}
const MESSAGES: Record<string, string> = {
  accessibility: "Allow Codex Deck Controls in System Settings > Privacy & Security > Accessibility, then press the mic again.",
  "app-not-running": "Open ChatGPT before using the microphone.",
  "composer-not-found": "Focus the chat composer in ChatGPT, then try the microphone again.",
  ambiguous: "More than one dictation control was found. Open just one composer.",
  "already-recording": "ChatGPT is already recording. This key will not take over that recording.",
  "start-unconfirmed": "ChatGPT did not confirm recording. Check its microphone permission and visible dictation control.",
  "stop-unconfirmed": "Could not confirm dictation stopped. Stop it in ChatGPT manually.",
  "scope-lost": "The original dictation composer changed. Stop recording in ChatGPT manually.",
  "press-failed": "ChatGPT did not accept the dictation control.",
  "session-mismatch": "The microphone session no longer belongs to this key.",
};

/** An independent app process owns TCC permission and the exact AX recording scope.
 * No UI access occurs at plugin startup: the helper launches on a user's mic press.
 */
export class MacDictationDriver implements DictationDriver {
  private server?: Server;
  private socket?: Socket;
  private directory?: string;
  private opening?: Promise<void>;
  private stopped = false;
  private serial = 0;
  private readonly pending = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly ended: (reason: string) => void,
    private readonly appPath = HELPER_APP,
    private readonly launch = async (appPath: string, path: string, token: string): Promise<void> => {
      await prepareHelper(appPath);
      await execFileAsync("/usr/bin/open", ["-n", "-g", "-a", appPath, "--args", "--connect", path, "--token", token], { timeout: 5_000 });
    }) {}
  async command(command: DictationCommand, session: string): Promise<void> {
    await this.open();
    if (!this.socket?.writable) throw new Error("Microphone helper is disconnected.");
    const id = ++this.serial;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error("Microphone helper timed out; check ChatGPT and stop recording manually if needed."));
        this.dispose();
      }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(`${JSON.stringify({ id, command, session })}\n`);
    });
  }
  close(): void { this.stopped = true; this.dispose(); }
  private dispose(): void {
    const socket = this.socket; this.socket = undefined; socket?.destroy();
    this.server?.close(); this.server = undefined;
    if (this.directory) { void rm(this.directory, { recursive: true, force: true }); this.directory = undefined; }
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Microphone helper disconnected. Check ChatGPT's recording control.")); }
    this.pending.clear();
  }
  private async open(): Promise<void> {
    if (this.stopped) throw new Error("Microphone helper is closed.");
    if (this.socket?.writable) return;
    if (this.opening) return this.opening;
    const pending = this.openOnce(); this.opening = pending;
    try { await pending; } finally { if (this.opening === pending) this.opening = undefined; }
  }
  private async openOnce(): Promise<void> {
    // Short path stays below macOS's sockaddr_un limit. Both directory and socket
    // are user-private; each invocation additionally authenticates a fresh token.
    const directory = await mkdtemp(`/tmp/codex-deck-mic-${process.getuid?.() ?? "user"}-`);
    this.directory = directory; await chmod(directory, 0o700);
    const path = join(directory, "control.sock");
    const token = randomBytes(32).toString("hex");
    let authenticated = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Microphone helper did not connect. Reinstall the macOS plugin package.")), 8_000);
        const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
        const server = createServer((socket) => {
          let buffer = ""; let accepted = false;
          const authTimer = setTimeout(() => socket.destroy(), 2_000);
          socket.setEncoding("utf8");
          socket.on("data", (chunk: string) => {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > 16_384) { socket.destroy(); return; }
            let end: number;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              let message: Record<string, unknown>;
              try {
                const parsed: unknown = JSON.parse(line);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid helper message");
                message = parsed as Record<string, unknown>;
              } catch { socket.destroy(); return; }
              if (!accepted) {
                const supplied = typeof message?.token === "string" ? Buffer.from(message.token) : Buffer.alloc(0);
                const expected = Buffer.from(token);
                if (authenticated || supplied.length !== expected.length || !timingSafeEqual(supplied, expected) || this.stopped) { socket.destroy(); return; }
                authenticated = accepted = true; clearTimeout(authTimer); this.socket = socket; finish(); continue;
              }
              if (message.event === "safety-stop") { this.ended("Recording stopped by the microphone safety timer."); continue; }
              if (message.event === "safety-stop-failed") { this.ended("Microphone safety stop failed; stop recording in ChatGPT manually."); continue; }
              if (typeof message.id !== "number") continue;
              const p = this.pending.get(message.id); if (!p) continue;
              this.pending.delete(message.id); clearTimeout(p.timer);
              if (message.ok === true) p.resolve();
              else p.reject(new Error(MESSAGES[String(message.error)] ?? "Microphone helper could not perform this action."));
            }
          });
          socket.on("error", () => {});
          socket.on("close", () => {
            clearTimeout(authTimer);
            if (this.socket === socket) { this.dispose(); if (!this.stopped) this.ended("Microphone helper disconnected; check ChatGPT's recording control."); }
          });
        });
        this.server = server;
        server.on("error", () => finish(new Error("Microphone helper socket failed.")));
        server.listen(path, () => {
          void chmod(path, 0o600).then(async () => {
            if (this.stopped) throw new Error("Microphone helper is closed.");
            await this.launch(this.appPath, path, token);
          }).catch(() => finish(new Error("Could not launch Codex Deck Controls. Reinstall the macOS plugin package.")));
        });
      });
    } catch (error) { this.dispose(); throw error; }
  }
}

type Session = { id: string; started: boolean };
export class MacOsDictation {
  private gesture: TalkGesture = { kind: "idle" };
  private session?: Session;
  private queue: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private keyHeld = false;
  private currentState: DictationState = "idle";
  private readonly driver: DictationDriver;
  constructor(private readonly changed: () => void, private readonly log: (message: string) => void, driver?: DictationDriver) {
    this.driver = driver ?? new MacDictationDriver((reason) => { this.reset(); this.setState(reason.startsWith("Recording stopped") ? "idle" : "error"); this.log(reason); });
  }
  get state(): DictationState { return this.currentState; }
  async key(act: 0 | 1): Promise<void> {
    if (this.stopped) throw new Error("Microphone controller is closed.");
    if (act === 1 && this.keyHeld) return;
    this.keyHeld = act === 1;
    const now = performance.now();
    // Deliver an overdue stop before interpreting a new press as a new session.
    if (this.gesture.kind === "waiting" && now >= this.gesture.until) void this.transition("timeout", now).catch(() => {});
    return this.transition(act === 1 ? "down" : "up", now);
  }
  close(): void { this.stopped = true; this.reset(); this.driver.close(); }
  cancel(): void {
    this.gesture = { kind: "idle" }; clearTimeout(this.timer);
    if (this.session) void this.effect("stop").catch((error) => this.log(String(error)));
  }
  private reset(): void { this.gesture = { kind: "idle" }; clearTimeout(this.timer); this.session = undefined; this.keyHeld = false; }
  private async transition(event: "down" | "up" | "timeout", now: number): Promise<void> {
    const next = talkTransition(this.gesture, event, now); this.gesture = next.state; clearTimeout(this.timer);
    if (next.deadline != null) this.timer = setTimeout(() => { void this.transition("timeout", performance.now()).catch((error) => this.log(String(error))); }, Math.max(0, next.deadline - now));
    if (next.effect) return this.effect(next.effect);
  }
  private effect(command: DictationCommand): Promise<void> {
    const session = command === "start" ? { id: randomUUID(), started: false } : this.session;
    if (!session) return Promise.resolve();
    if (command === "start") { this.session = session; this.setState("starting"); }
    const operation = this.queue.then(async () => {
      if (this.stopped) return;
      if (command !== "start" && !session.started) return;
      if (command === "stop" && this.session === session) this.setState("stopping");
      await this.driver.command(command, session.id);
      if (command === "start") session.started = true;
      if (this.session !== session) return;
      if (command === "stop") { this.session = undefined; this.setState("idle"); }
      else this.setState(command === "latch" ? "hands-free" : "recording");
    });
    this.queue = operation.catch((error) => {
      if (this.session === session) { this.reset(); this.setState(String(error).includes("Accessibility") ? "permission-required" : "error"); }
    });
    return operation;
  }
  private setState(state: DictationState): void {
    if (this.currentState !== state) { this.currentState = state; this.log(`Normal-launch microphone: ${state}`); this.changed(); }
  }
}
