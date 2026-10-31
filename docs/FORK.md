# tobitti fork

This fork starts at upstream tag `v0.7.0.2`
(`6d7d14b9c966de305617a43a7ac22c7034ac075e`). The npm version is
`0.7.0-tobitti.2`; the numeric Stream Deck manifest version is `0.7.0.1002`.
Action UUIDs are preserved so existing OpenDeck profiles remain usable.

## Git layout

- `origin`: https://github.com/tobitti0/codex-stream-deck.git
- `upstream`: https://github.com/dazer1234/codex-stream-deck.git
- Integration branch: `future/opendeck-base`
- Baseline tag: `v0.7.0-tobitti.1`
- Compatibility fix tag: `v0.7.0-tobitti.2`
- `main` tracks the existing fork's `origin/main`.

## Integrated upstream PRs

| PR | Purpose | Imported head |
| --- | --- | --- |
| [#17](https://github.com/dazer1234/codex-stream-deck/pull/17) | Passive macOS watcher, stale-lock recovery, and shared event-bus discovery | `2acacf64bcf3451b9ea1fba13f1ecb8cf3bc871e` |
| [#9](https://github.com/dazer1234/codex-stream-deck/pull/9) | Accept bare and `local:`-prefixed thread IDs during activation | `7ff4c81deeb54d75d8ea621ac4273eb6e9b1715d` |
| [#10](https://github.com/dazer1234/codex-stream-deck/pull/10) | Larger titles and clearer, staggered state indicators | `165b1c5faf5fd03890fe7dd2791850106ca24b56` |
| [#12](https://github.com/dazer1234/codex-stream-deck/pull/12) | Optional macOS focus before agent presses and folder labels | `4396d7702dfc4e3c4edfc2eb3eef5aeceefb78f4` |

Merge commits retain upstream authorship. The #10/#12 rendering overlap is
resolved by placing compact folder labels below the indicator strip while
keeping the enlarged three-line task title. macOS focus remains opt-in.
Full-width Japanese titles wrap at six glyphs per line, with character-width
aware font fitting, to prevent the enlarged titles from clipping at key edges.

#17 already includes #16's shared `app-shared-*` event-bus discovery change.
The remaining Windows activation changes from #16 are not imported. #13's
large Stream Deck Plus/dial/model-preset expansion is deferred until this
OpenDeck baseline is validated.

## Build and verify

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run validate
npm run audit:release
./release/codex-deck-launcher-macos/start-codex-deck.sh self-test
./release/codex-deck-launcher-macos/start-codex-deck.sh dry-run
CODEX_DECK_RELEASE_VERSION=0.7.0-tobitti.2 ./scripts/package-macos-release.sh
```

The plugin is built under `dist/com.simeo.codex-deck.sdPlugin`; the macOS
launcher is under `release/codex-deck-launcher-macos`.

The original Downloads launcher is upstream's unchanged reference copy.
Use the newly built launcher when testing this fork.

## Live validation boundary

Builds, automated tests, package validation, and release audits do not prove
live renderer or physical-device compatibility. The installed desktop version
for this integration is `26.1027.30824` (build `22943`).

A normally started desktop session still lacks the debugging endpoint required
by this bridge. After saving unsent text, explicitly restart it through the
built launcher before checking native event handlers and six-slot snapshots:

```sh
./release/codex-deck-launcher-macos/start-codex-deck.sh start --restart
npm run smoke:local
```

The smoke check reads three real six-slot snapshots and writes an aggregate
report to `outputs/local-smoke.json`. It sends no agent, approval, or keycap
commands and does not log task titles or IDs. It fails explicitly when no live
bridge is available.

The passive watcher never restarts a session automatically. A transport that
works with ordinary app launches is separate future work.

## Initial v0.7.0-tobitti.1 validation (2026-10-31)

- TypeScript check: passed.
- Automated tests: 150 passed, one Windows-only PowerShell test skipped.
- Plugin build and Stream Deck manifest validation: passed.
- Release audit: passed for all three artifact roots.
- Bundled macOS launcher self-test: passed.
- Dry-run: detected the installed app; it is currently running without a
  debugging endpoint, so live Micro validation awaits an explicit restart.
- Live smoke check: explicitly reported no debugging endpoint; six-slot
  snapshots and native control actions remain unverified until restart.
- OpenDeck: installed and registered plugin `0.7.0.1001`; both the management
  screen and new plugin process report that version. Existing MobileDeck
  action assignments remain present. Installed runtime checksums match the
  built plugin.
- The manifest keeps Node debug mode disabled, matching the existing OpenDeck
  installation.
- Dependency audit: three high-severity production dependency findings are
  inherited through `@elgato/streamdeck` / `@elgato/utils` / `zod`.
  The suggested automated fix downgrades the Stream Deck SDK across a major
  version; that dependency migration is outside this baseline integration.

The fork launcher is also copied to `~/Downloads/codex-deck-launcher-macos-tobitti`.
The previous OpenDeck plugin, profiles, and settings are backed up under
`~/Library/Application Support/CodexDeck/backups/<timestamp>/` before installation.

## v0.7.0-tobitti.2 compatibility fix (2026-10-31)

Live testing found that native Micro activation succeeded but six-slot reads
failed: the app had cleared its Resource Timing entries, leaving the dedicated
slot-signal module invisible to DOM/resource discovery.

- Inventory loaded scripts using CDP `Debugger.scriptParsed` on connection,
  then disable that CDP domain again. No pause or breakpoint is used.
- Keep only allowlisted local Micro/shared renderer modules, with no fixed
  build hashes, and supply that inventory to snapshot discovery.
- Prefer the dedicated six-slot resolver module; support the same resolver
  interface from shared modules when needed.
- Accept the current host/account-scoped `rate-limit-status` query keys. Use
  one active populated snapshot; ambiguous accounts remain unavailable.
- Keep the legacy unscoped usage query compatible.
- Regression coverage includes empty Resource Timing, both resolver module
  layouts, scoped usage, pending queries, and ambiguous account data.

Validation on desktop `26.1027.30824` (`22943`):

- TypeScript check passed; 156 tests passed, one Windows-only test skipped.
- Launcher activation and native HID/joystick handler readiness passed.
- Three consecutive real snapshots returned six occupied slots, one selected
  slot, working/idle statuses, the dark theme, and usage data.
- OpenDeck plugin `0.7.0.1002` registered with local host health `ready`.
  The installed runtime matches the built artifact. Its UI displays all six
  task tiles and weekly usage; the current account response contains only the
  weekly window, so the five-hour key correctly stays unavailable.
- Approval, rejection, submission, reset-credit consumption, and other task
  mutations were not exercised by this read-only smoke test.

This restores status/usage acquisition through a launcher-enabled session.
Normal-launch transport remains separate future work.
