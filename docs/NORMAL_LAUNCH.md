# Normal-launch macOS integration

Branch: `future/launcher-free-integration`, based on
`future/local-ipc-investigation`. Package `0.7.0-tobitti.6`, plugin `0.7.0.1006`.

## Setup

Install the built plugin in OpenDeck or Stream Deck, then open ChatGPT as
usual. In any Agent Display inspector, select **Normal launch / local IPC**.
This is the macOS default and is shared by all six agent keys. Existing action
UUIDs and profile assignments are preserved. Windows keeps its native bridge.

Status and chat switching use no virtual HID, modified app, debug listener,
Accessibility permission, or launcher. The microphone uses a separate optional
Accessibility helper; see [microphone setup and validation](NORMAL_LAUNCH_MICROPHONE.md).
The installed ChatGPT app is left untouched.

## Capabilities

| Control | Normal launch | Source / limitation |
| --- | --- | --- |
| Recent six local chats | Supported | Bundled app-server `thread/list`, ordered by recency; excludes archived, child and ephemeral chats |
| Live chat status | Supported when an IPC owner exists | Desktop IPC, with exact chat IDs and revision resynchronization |
| Other recent-chat status | History fallback | Latest turn via app-server; completed means idle, not unread; in-progress history alone is unavailable |
| Switch to displayed chat | Supported | `codex://threads/<id>`; confirmed by the user from MobileDeck |
| New chat | Supported | `codex://threads/new` |
| Account usage remaining | Supported when returned by API | Bundled app-server `account/rateLimits/read`; actual 5-hour / weekly duration determines the label |
| Micro settings / custom native assignments | Not mirrored | This mode supplies its own recent-six list and default action artwork |
| Currently selected UI chat | Not established | Stream-following announcements do not prove UI focus |
| Microphone / push-to-talk | Implemented via optional Accessibility helper | Hold/release and double-press latch; live recording verification pending user testing |
| Send | Requires native launcher mode | No global composer send command implemented on the IPC bus |
| Fast, approve/reject, fork, reasoning | Requires native launcher mode | Some owner-targeted IPC handlers exist, but a safe current-UI target is not established |
| Joystick, encoder and remaining keycaps | Requires native launcher mode | Native event path retained; no global IPC equivalent implemented |
| Consume reset credits | Requires native launcher mode | Usage reading does not authorize or implement reset consumption |

Unsupported controls retain their normal icon with a small **Launcher** badge.
Restoring their artwork does not enable their operation. Switch the shared
connection setting to **Launcher / native Micro** and start with the existing
launcher when those actions are needed. The plugin does not silently launch a
debug session or send a command to an inferred selected chat.

`IPC` on a chat key means live desktop status. `H` means history fallback.
The IPC list is rediscovered after a reconnect; a revision gap invalidates live
state until a fresh snapshot arrives. Catalog metadata is refreshed every ten
seconds and expires after thirty seconds of failed reads. History reads are
skipped when live IPC already supplies that chat's status. No selected-chat
highlight is fabricated from streaming subscriptions.

Usage refreshes independently every thirty seconds. A failed read can retain
its last value for at most sixty seconds, then it becomes unavailable. A
missing window displays **—**; it is never substituted with another window or
zero. The observed installed build returned weekly usage only. These values
are usage-limit percentages, not a count of purchased tokens. They belong to
the bundled CLI's authenticated account; users with differing CLI/desktop
accounts should check that account alignment separately.

## Validation and privacy

Validated with normally launched ChatGPT `26.1027.30824` (22943) and OpenDeck
on macOS. The user confirmed that a MobileDeck key opens the chat shown on the
key. This verifies chat switching, not microphone or other native actions.

```sh
npm run check
npm test
npm run validate
npm run audit:release
npm run smoke:normal
npm run measure:normal
```

The smoke check reads aggregate status and capability information only; it
does not switch chats, change settings, approve requests, or send messages.
Its report is written to ignored `outputs/normal-launch-smoke.json` without
titles, chat IDs, file paths or conversation contents.

The separate app-server child reads the catalog, latest turn status and account
limits. It never resumes a chat or sends a turn. Private desktop IPC can carry
conversation content; only title and runtime/unread projection are retained,
and unrelated content is discarded. Socket ownership and private permissions
are checked before connecting. The transport is undocumented and can change
after an app update; errors surface as unavailable status rather than a guessed
command or status.

## Load controls

This private follower protocol transfers complete chat snapshots and content
patches, not just the few status fields we display. Initial traffic can be
large. The decoder allocates each frame once, body-only patches advance the
revision without triggering a display refresh, and healthy subscriptions do
not request full snapshots every thirty seconds. A light owner probe runs
every sixty seconds; revision gaps still request a new snapshot. Normal-launch
agent animation is limited to two frames per second.

If incoming traffic exceeds 32 MiB, or decoding/projection takes more than one
second of wall time, within a ten-second window, the IPC connection closes and
cools down for sixty seconds. The catalog remains available and keys use
history fallback rather than keeping stale live status. These are conservative
resource limits, not a guarantee about the app's own rendering or serialization
cost. Logs record budget stops and content-free performance counters every
thirty seconds: one-core CPU percentage, RSS, heap, image sends, IPC bytes,
frames and visible changes.

`measure:normal` performs a bounded off/on/off test (8/20/8 seconds) with no UI,
microphone, key actions or task mutations. It records aggregate host/process
CPU, memory and protocol counts to ignored `outputs/normal-load-measurement.json`.
It stops early on sustained high load. Run it without another plugin/probe IPC
connection when comparing phases. The first local run of the optimized code
measured the probe at 0.58% of one core on average and 144 MiB maximum RSS;
probe plus catalog averaged 1.27% of one core. Host CPU averaged 48.36% before,
48.37% during and 48.15% after. Initial snapshots totaled 13,838,384 bytes;
the largest frame was 9,536,124 bytes. The run completed with no load-budget
stop. These twenty seconds do not establish long-running behavior, microphone
cost, or OpenDeck rendering cost, and do not establish the cause of the earlier
system stutter. Native launcher mode has not been measured under matching
conditions, so no comparative performance claim is made.

After deploying 1006 and restarting OpenDeck, several minutes of thirty-second
plugin-process samples measured 0.21–0.61% of one core and 73–87 MiB RSS. Image
sends settled at two per second, full snapshots remained at the initial six,
and no budget stop occurred. This includes plugin-side image generation and
sending, but not OpenDeck's native renderer or the independent AX helper.
Microphone attempts returned permission-required, so actual recording cost
remains unmeasured.
