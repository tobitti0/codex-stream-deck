# Existing launcher-free approaches

Source review on 2026-10-31. The target is a normally launched, unmodified
ChatGPT desktop app, with the same six task assignments selected in its Micro
settings. A separate dashboard with its own task ordering is a different
capability, even if it needs no launcher.

These projects were inspected, not installed or executed. Their reported
runtime success is distinguished from our own local compatibility checks.

| Project | Normal-launch route | App-side Micro assignments | Finding for this fork |
| --- | --- | --- | --- |
| [ThreadDeck](https://github.com/y5862000/threaddeck-for-codex) | On supported builds, activates the running app's Node inspector, installs an authenticated renderer command socket, then closes the inspector | Native six-slot adapter exists; its main dashboard also has an independent eight-task list | Closest software-only candidate, but its activation prerequisite is disabled in the installed ChatGPT build |
| [Codex Micro Phone](https://github.com/maxxspotter/codex-micro-app) | Standard Bridge uses desktop IPC, app-server, local metadata and Accessibility | Standard Bridge resolves pinned tasks and fills with recent tasks itself; its Native Shim follows Micro settings but requires special launch | Useful IPC reference; ordinary-launch mode does not supply the required native six-slot mapping |
| [dada2623/CodexDeck](https://github.com/dada2623/CodexDeck) | Connects to the app-server control socket, starting the bundled daemon if needed | `service.ts` requests `thread/list`, sorts by active/error and recency, then takes its own slot count | Launcher-free monitoring exists, but selection is independent of Micro settings |
| [DEXCERRONE bridge](https://github.com/DEXCERRONE/stream-deck-codex-micro) | Read-only task DB/rollout status plus Apple events and shortcuts | Displays its own recent tasks | Does not solve authoritative Micro assignments |
| [YutaHasimoto plugin](https://github.com/YutaHasimoto/codex-micro-deck) | Desktop follower IPC, app-server, local DB/rollouts and selected UI actions | Recent tasks or per-key fixed IDs in the plugin; README identifies priority/pinned Micro modes as unimplemented | Good distinction between live IPC and task discovery; different assignment authority |
| [mpociot emulator](https://github.com/mpociot/codex-micro-stream-deck-emulator) | OS virtual-HID helper is the intended normal-launch route; proven route is launch-time `NODE_OPTIONS` shim | Device protocol receives native slot lighting | Native helper runtime is explicitly entitlement-blocked; not a demonstrated drop-in solution |
| [thuongtin Neo fork](https://github.com/thuongtin/codex-micro-stream-deck-neo) | Optional login watcher relaunches an ordinarily opened app with the shim | Native lighting through shim/helper | Removes a manual step by relaunching; does not leave an ordinary app process untouched |
| [Codex Micro Lab](https://github.com/42libft/codex-micro-lab) | Builds a modified, re-signed lab copy of a specifically supported app version | Instrumented native Micro path | A research app-copy approach, not normal operation of the installed unmodified app; its true virtual-HID path remains entitlement-dependent |

## ThreadDeck: the promising mechanism and the current blocker

The relevant implementation is:

- [`micro-main-inspector.js`](https://github.com/y5862000/threaddeck-for-codex/blob/main/src/micro-main-inspector.js): verifies the exact process, loopback listener ownership and inspector fuse, then sends `SIGUSR1` only if allowed.
- [`micro-prepared-bridge.js`](https://github.com/y5862000/threaddeck-for-codex/blob/main/src/micro-prepared-bridge.js): prepares the authenticated local socket that evaluates operations in the app's renderer.
- [`electron-fuses.js`](https://github.com/y5862000/threaddeck-for-codex/blob/main/src/electron-fuses.js): checks the framework actually mapped by the running process, including file identity.
- [September compatibility guard](https://github.com/y5862000/threaddeck-for-codex/commit/a684b8d81efc967b64a44226fc7a027f85a37f32): explicitly skips activation on disabled or unverifiable builds.

This is a runtime bootstrap using a debugger. It is not a public service
already exposed on the desktop coordination socket. It can avoid a launcher on
builds that permit inspector activation, but permission to activate is a build
property rather than an Accessibility or Input Monitoring setting.

Our read-only check of ChatGPT 26.1027.30824 (22943) found:

```json
{
  "fuseSchemaVersion": 1,
  "enableNodeCliInspectArguments": false,
  "enableNodeOptionsEnvironmentVariable": false,
  "normallyLaunched": true,
  "frameworkMappedByCurrentProcess": true,
  "signalSent": false
}
```

The Electron framework's device/inode identity matched a mapped text file of
the current main process. Thus this is not merely a reading of some unrelated
Electron installation or an older on-disk copy. No signal, code injection,
binary patch, app restart, or persistent listener was used in this check.

[Electron's official fuse documentation](https://www.electronjs.org/docs/latest/tutorial/fuses)
states that disabling the Node inspector fuse also prevents `SIGUSR1` from
opening the main-process inspector. It separately documents the `NODE_OPTIONS`
fuse. Both avenues used by these projects are disabled in the checked build.
Existing launcher CDP uses a different Chromium debugging path; its successful
operation does not imply that Node inspector activation is enabled.

ThreadDeck's fallback remains useful as a task dashboard, but it does not make
the unavailable native mapping path available on this build. Flipping the
installed app's fuse bytes is not an entitlement fix and was not performed.

## Source checks behind the other rows

- Phone [slot resolver](https://github.com/maxxspotter/codex-micro-app/blob/main/apps/mac-companion/Sources/CodexMicroCore/SlotMapping.swift): implements its own pinned/recent allocation and preserves prior recent bindings.
- CodexDeck [client](https://github.com/dada2623/CodexDeck/blob/main/src/codex/client.ts) and [service](https://github.com/dada2623/CodexDeck/blob/main/src/codex/service.ts): control-socket transport and independent `thread/list` sorting. The installed bundled CLI advertises `app-server daemon`; only `--help` was run, no daemon was started.
- DEXCERRONE [state reader](https://github.com/DEXCERRONE/stream-deck-codex-micro/blob/main/bridge/src/state.mjs): local SQLite and bounded rollout-tail parsing.
- YutaHasimoto [README](https://github.com/YutaHasimoto/codex-micro-deck/blob/main/README.md): explicitly describes recent/fixed assignment and the separate IPC/settings path.
- mpociot [development status](https://github.com/mpociot/codex-micro-stream-deck-emulator/blob/main/DEVELOPMENT.md): distinguishes working shim from entitlement-blocked helper.
- Neo [setup](https://github.com/thuongtin/codex-micro-stream-deck-neo/blob/main/README.md): states that Dock launch omits the shim and that its watcher relaunches the app.
- Lab [patch implementation](https://github.com/42libft/codex-micro-lab/blob/main/src/lab-patch.ts): checks a fixed app version/hash, modifies extracted bundles in a copy, and re-signs that copy.

## Decision

The review found launcher-free implementations for independent task monitoring,
and a conditional runtime-bootstrap implementation for native controls. It did
**not** establish a working route that satisfies all of: the current unmodified
ChatGPT build, ordinary launch, and authoritative native Micro six-slot mapping.

The candidate that preserves the actual hardware path without changing the app
is still a profile-authorized virtual-HID helper. Its entitlement barrier is now
diagnosed, but its actual native recognition and the conversation-title mapping
remain unverified; see [virtual-HID investigation](VIRTUAL_HID_FEASIBILITY.md).
No DB/hotkey fallback, alternative plugin, watcher, or modified app was deployed.
