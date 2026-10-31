# Normal-launch microphone (macOS)

Plugin `0.7.0.1006` implements the existing **Action 5 / Push-to-talk** through
a bundled **Codex Deck Controls.app**. ChatGPT opens normally, without the
launcher, a debug endpoint, an injected device, or app modification. Windows
and the explicit Launcher / native Micro connection keep their native routing.

## One-time setup and manual test

1. Select an Agent key in OpenDeck. Set Connection to **Normal launch (macOS IPC)**.
2. Click **Microphone setup (macOS)** once. In the helper dialog, open
   Accessibility Settings and allow **Codex Deck Controls**. If it is missing,
   add the helper from the plugin's `bin/Codex Deck Controls.app` directory.
   The permission must be granted by the user; installing the plugin does not
   grant it. An ad-hoc developer build may require reauthorization after changes.
3. Open a ChatGPT chat and focus its composer. On MobileDeck, hold the microphone
   key, speak, then release. Verify recording starts, stops, and adds text to
   the composer. Do not send the text unless desired. ChatGPT may separately
   ask for its own microphone permission.
4. Optional: press/release and press again within 350 ms to latch hands-free
   recording, then press again to stop. Verify that manual recording started
   outside the plugin is left alone.

If OpenDeck shows an old property inspector after a plugin update, restart
OpenDeck once. No ChatGPT restart is required. OpenDeck may drop the helper's
executable bit when extracting ZIPs; the plugin restores the mode of its own
bundled executable before launch.

The key keeps its microphone artwork: **AX** means the normal-launch route,
**REC** means the app exposed its recording control, **REC · HF** means latched,
**Allow AX** requests permission setup, and **Check app** means a failed action
needs attention. A start acknowledgement alone never produces REC. The Send
key still requires native launcher mode; this microphone path does not send
prompts automatically. Voice Chat mode is separate and is not implemented.

## Implementation and load boundaries

The helper uses Apple's Accessibility API to press exact English/Japanese
Dictate and Stop dictation buttons in the active ChatGPT composer. It remembers
the originating scope and a random session ID. Key release waits for a pending
start, then stops only that owned session. Ambiguous controls, existing manual
recording, missing permission and failed post-conditions return errors without
guessing a toggle or sending a keyboard shortcut. No audio or composer value
is read by the helper. Only role, button metadata and phase are inspected.

The helper is launched only on a user's microphone press or explicit setup
button. It is an independent accessory app with its own TCC identity and uses
a short private Unix socket, mode-0700 directory, mode-0600 endpoint and fresh
authentication token. It has no TCP listener or login item. A 60-second hold
watchdog / five-minute hands-free watchdog attempts to stop an owned recording.
Stop failures are retried only a bounded number of times and require manual
attention if the original scope was lost. Disconnect cleanup is best effort.

AX queries are bounded by time, node count and a shared call budget. The focused
composer is preferred; fallback search is bounded and may require the user to
focus the composer rather than scan a large chat. There is no continuous AX
polling at idle. Setup requires an explicit `--setup` action, shares a lock
between concurrent launches, and completes Launch Services startup before
showing a dialog. Microphone permission errors do not reopen setup automatically.
Native builds are cached by source/compiler/SDK fingerprint; compilation runs
at reduced priority.

## References and validation

Reference implementations inspected, not installed or executed:

- [Codex Micro Phone Accessibility controls](https://github.com/maxxspotter/codex-micro-app/blob/main/apps/mac-companion/Sources/CodexMicroCore/CodexAccessibility.swift) and [dictation session ownership](https://github.com/maxxspotter/codex-micro-app/blob/main/apps/mac-companion/Sources/CodexMicroCore/GlobalDictationController.swift): Swift AX actions, persistent composer scope, explicit stop and watchdog.
- [YutaHasimoto Accessibility controller](https://github.com/YutaHasimoto/codex-micro-deck/blob/main/src/codex/accessibility-controller.ts): exact Japanese/English controls, ambiguous-control rejection and start verification. This fork uses its own Swift helper rather than AppleScript or an app-version-specific fixed element path.
- [Official Micro voice behavior](https://learn.chatgpt.com/docs/features/codex-micro): hold/release and double press within 350 ms.
- Apple's [trust check](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions) and [AX actions](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction).

Automated tests cover gesture timing, release during slow startup, failed and
externally owned starts, permission retry, native-mode routing, private transport,
safe error projection and key artwork. Both arm64 and x86_64 helpers are built,
ad-hoc signed, and run label self-checks with **no UI access**. Those checks do
not prove real recording or transcription. Live recording validation and its
load measurement remain pending the user's permission/setup and hardware test.
