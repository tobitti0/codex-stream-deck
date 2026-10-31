# Normal-launch macOS integration

Branch: `future/launcher-free-integration`, based on
`future/local-ipc-investigation`. Package `0.7.0-tobitti.4`, plugin `0.7.0.1004`.

## Setup

Install the built plugin in OpenDeck or Stream Deck, then open ChatGPT as
usual. In any Agent Display inspector, select **Normal launch / local IPC**.
This is the macOS default and is shared by all six agent keys. Existing action
UUIDs and profile assignments are preserved. Windows keeps its native bridge.

No virtual HID, modified app, debug listener, Accessibility permission, or
launcher is used for this mode. The installed signed app is left untouched.

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
| Microphone / push-to-talk, send | Requires native launcher mode | No equivalent global composer command established on the IPC bus |
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
state until a fresh snapshot arrives. Catalog metadata is refreshed every five
seconds and expires after fifteen seconds of failed reads. No selected-chat
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
