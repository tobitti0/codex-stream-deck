import assert from "node:assert/strict";
import test from "node:test";
import { encodeIpcFrame, IpcFrameDecoder, projectStatus, visualStatus } from "../src/experimental/local-ipc-probe.js";

test("IPC framing handles split UTF-8 payloads and consecutive messages", () => {
  const first = { type: "fixture", label: "日本語" };
  const second = { type: "fixture", count: 2 };
  const bytes = Buffer.concat([encodeIpcFrame(first), encodeIpcFrame(second)]);
  const decoder = new IpcFrameDecoder();
  const received = [];
  for (const byte of bytes) received.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(received, [first, second]);
});

test("IPC framing rejects oversized and zero-length headers before waiting for a body", () => {
  for (const size of [0, 16 * 1024 * 1024 + 1]) {
    const header = Buffer.alloc(4); header.writeUInt32LE(size);
    assert.throws(() => new IpcFrameDecoder().push(header), /frame length/);
  }
});

test("fragmented large frames allocate only their payload size rather than recopying a growing buffer", () => {
  const packet = { type: "fixture", body: "x".repeat(1024 * 1024) };
  const bytes = encodeIpcFrame(packet);
  const decoder = new IpcFrameDecoder();
  const received = [];
  for (let at = 0; at < bytes.length; at += 1024) received.push(...decoder.push(bytes.subarray(at, at + 1024)));
  assert.deepEqual(received, [packet]);
  assert.equal(decoder.allocatedBytes, bytes.length - 4);
  assert.equal(decoder.frames, 1);
});

test("status projection drops conversation content and follows matching revisions", () => {
  const first = projectStatus(undefined, { type: "snapshot", revision: 3, conversationState: {
    title: "Private title", turns: [{ text: "Private text" }], threadRuntimeStatus: { type: "active", activeFlags: [] }, hasUnreadTurn: false
  } })!;
  assert.equal(visualStatus(first), "working");
  assert.doesNotMatch(JSON.stringify(first), /Private/);
  const next = projectStatus(first, { type: "patches", baseRevision: 3, revision: 4, patches: [
    { op: "replace", path: ["threadRuntimeStatus"], value: { type: "idle" } },
    { op: "replace", path: ["hasUnreadTurn"], value: true },
    { op: "add", path: ["turns", 0], value: { text: "More private text" } }
  ] })!;
  assert.equal(visualStatus(next), "unread");
  assert.doesNotMatch(JSON.stringify(next), /private/);
  assert.equal(projectStatus(next, { type: "patches", baseRevision: 1, revision: 5, patches: [] }), undefined);
});

test("approval/input/error/unloaded states are distinct and unsupported array patches request a snapshot", () => {
  for (const [runtime, expected] of [
    [{ type: "active", activeFlags: ["waitingOnApproval"] }, "awaiting-approval"],
    [{ type: "active", activeFlags: ["waitingOnUserInput"] }, "awaiting-response"],
    [{ type: "systemError" }, "error"], [{ type: "notLoaded" }, "unavailable"]
  ] as const) {
    const state = projectStatus(undefined, { type: "snapshot", revision: 1, conversationState: { threadRuntimeStatus: runtime } })!;
    assert.equal(visualStatus(state), expected);
    assert.equal(projectStatus(state, { type: "patches", baseRevision: 1, revision: 2, patches: [
      { op: "add", path: ["threadRuntimeStatus", "activeFlags", 0], value: "waitingOnUserInput" }
    ] }), undefined);
  }
});
