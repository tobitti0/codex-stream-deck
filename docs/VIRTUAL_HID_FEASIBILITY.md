# Virtual Micro feasibility on macOS

Investigated on 2026-10-31 with macOS 26.5.2, Apple Silicon, the macOS SDK in
Xcode, and ChatGPT 26.1027.30824 (build 22943).

**The first virtual-HID failure was an entitlement rejection, not evidence that
macOS cannot emulate the device.** A profile-authorized CoreHID helper is a
plausible launcher-free device transport. Recognition by ChatGPT is still
unverified because the required signing inputs are unavailable on this Mac.

## Reproduced failure and signing boundary

| Experiment | Result | Interpretation |
| --- | --- | --- |
| Swift CoreHID probe, ad-hoc signature, no restricted entitlement | Constructor returned `nil`; process exited normally | Kernel refused the HID user client |
| Same probe in an `.app`, claiming Virtual HID with an ad-hoc signature | Terminated with `SIGKILL` before `main` | AMFI rejected a restricted entitlement without acceptable signing authorization |
| Read-only signing inventory | No valid code-signing identities in the configured keychain search list; neither standard local provisioning-profile directory exists | No profile-authorized runtime test is available locally; this says nothing about the user's online Developer Program membership |

Only short, content-free diagnostics are reproduced here. Full logs remain in
ignored local output, not in source control:

```text
IOServiceOpen:0xe00002c2
IOHIDResourceDeviceUserClient: virtual-hid-chec is not entitled
AppleMobileFileIntegrityError Code=-424
The file is adhoc signed but contains restricted entitlements
```

`0xe00002c2` is `kIOReturnBadArgument`, so the numeric error alone is not enough
to diagnose this. The accompanying kernel message identifies the entitlement
failure. The installed public SDK's `IOHIDUserDevice.h` explicitly requires
`com.apple.developer.hid.virtual.device`. Apple's open-source HID user-client
initialization checks this entitlement before creating the device. It also
accepts an Apple-private entitlement; that is not an option for this project.
The inspected check has no UID-0 exemption, so `sudo` alone is not the proposed
remedy. No privileged test was performed.

Input Monitoring for ChatGPT concerns consuming device input. It does not grant
our helper the authority to create a virtual HID device. Similarly, a Developer
ID signature alone does not grant a managed capability: the helper's entitlement
must be authorized by the matching Apple-issued provisioning profile.

## What proper signing would require

For this investigation the preferred architecture is a small CoreHID helper,
separate from the OpenDeck plugin. CoreHID provides virtual devices directly;
we have not established any need for a custom DriverKit extension. Do not
substitute `com.apple.developer.driverkit.family.hid.virtual.device` for the
CoreHID entitlement.

The intended supported signing path is:

1. Obtain Apple's approval for **HID Virtual Device / Virtual HID**, entitlement
   `com.apple.developer.hid.virtual.device`, for the helper's App ID.
2. Enable that capability and generate a macOS provisioning profile for the
   exact App ID and signing certificate. For distribution outside the App Store,
   use the appropriate Developer ID profile and Developer ID Application identity.
3. Put the executable and `Info.plist` in an `.app`, embed the profile at
   `Contents/embedded.provisionprofile`, and sign with the profile-authorized
   entitlement, application identifier, and team identifier.
4. Verify the resulting signature and profile, then run the benign probe below.
   Distribution also needs the appropriate notarization/Gatekeeper workflow;
   notarization is not a replacement for the entitlement grant.

Account approval and provisioning cannot be manufactured by editing a plist.
No capability request was submitted and no Apple account, keychain, TCC, SIP,
AMFI, or system-extension configuration was changed during this investigation.
Only disposable local probe binaries were signed.

## Can that device be recognized as Micro after a normal launch?

The installed app's macOS native addon enumerates `IOHIDDevice` registry services
and creates IOHIDDevice references. Its inspected matching path uses the device
identity and vendor-defined usage page. Its imported APIs do not include a USB
parent-topology query, and no explicit virtual-device exclusion was found in the
inspected path. The JavaScript service then selects a supported product and opens
its HID transport.

The candidate Codex Micro interface must expose:

| Property | Expected value |
| --- | --- |
| Vendor ID | `0x303A` |
| Product ID | `0x8360` |
| Application collection usage page | `0xFF00` |
| Report framing | Vendor reports, report ID `0x06`, 64-byte reports including the report ID |
| Transport/version metadata | Consistent with the app's supported USB/Bluetooth path |

CoreHID exposes the descriptor, vendor/product IDs, transport, and version
properties needed to describe that candidate. This is **static feasibility
evidence**, not a live recognition result. It still needs to be activated,
enumerated by the actual native addon, opened by ChatGPT, and kept responsive.
No authenticated hardware challenge was found in the inspected connection path;
that observation is not a guarantee against additional checks or future changes.

Presenting the identity alone is insufficient. The emulator must answer the
app's vendor RPCs, including initial lighting configuration, per-slot lighting,
device status, and reconnection. The native service distinguishes discovery,
connection, and an unavailable control plane when lighting communication fails.
A device that merely enumerates does not pass the connection test.

The proposed test sequence after profile authorization is:

1. Run the unrelated benign probe to establish that HID creation is permitted.
2. Activate a vendor-only Micro-compatible interface with no keyboard/mouse
   collection. Verify native discovery, without any synthetic task key events.
3. Start the read-only device RPC responder, and verify that a normally launched
   ChatGPT reports a stable connection and sends live six-slot lighting updates.
4. Change the Micro assignments in ChatGPT and verify corresponding slot updates.
   Keep app-side selection authoritative.
5. Verify disconnect/reconnect and removal of the helper without restarting
   ChatGPT through a launcher.

Even success through step 5 would not prove a full OpenDeck title/identity path:
the inspected lighting messages contain slot numbers and visual effects, not
conversation UUIDs or titles. That remaining mapping must be demonstrated
separately, not inferred from coincident status changes or IPC arrival order.

## Repeatable benign probe

This builds an isolated `.app` under ignored `outputs/`. It does not install or
run it, claim the Micro identity, or send any input reports:

```sh
python3 scripts/build-virtual-hid-probe.py
./outputs/virtual-hid-probe/CodexDeckHIDProbe.app/Contents/MacOS/CodexDeckHIDProbe
```

The unsigned-capability baseline is expected to print
`"virtualHidCreated":false` on the tested secured Mac.

After obtaining a valid certificate and profile, build with the matching App ID:

```sh
python3 scripts/build-virtual-hid-probe.py \
  --bundle-id 'your.helper.bundle.identifier' \
  --identity 'your signing identity' \
  --profile '/path/to/authorized.provisionprofile'
```

The builder rejects a profile missing the entitlement, a mismatched App ID,
non-macOS targeting, and an expired profile before signing. A successful
`codesign --verify` does not itself prove AMFI accepts the entitlement at runtime;
the actual constructor test remains necessary. Profiles and generated apps are
never release artifacts of the OpenDeck plugin.

## Related implementation

The independent [mpociot emulator](https://github.com/mpociot/codex-micro-stream-deck-emulator/blob/main/DEVELOPMENT.md)
has both a launcher-injected shim and a virtual-HID helper. Its development
notes report the same entitlement barrier and explicitly mark native-helper
runtime as blocked. It is not evidence of an already-working, ordinarily
launched native-helper route. Its older SDK discovery assumptions also need
checking against the installed app's native topology addon. No code from that
project or proprietary app assets were copied into this probe.

## Sources

- [Apple CoreHID virtual devices](https://developer.apple.com/documentation/corehid/creatingvirtualdevices)
- [Apple Virtual HID entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.hid.virtual.device)
- [Apple managed capability requests](https://developer.apple.com/help/account/capabilities/capability-requests/)
- [Apple signing and entitlement troubleshooting](https://help.apple.com/xcode/mac/current/en.lproj/dev298d7b2cb.html)
- [Apple HID user-client source](https://github.com/apple-oss-distributions/IOHIDFamily/blob/main/IOHIDFamily/IOHIDResourceUserClient.cpp)
- [Official OpenAI Micro setup](https://learn.chatgpt.com/docs/features/codex-micro)

The installed SDK header and app binaries were inspected locally only. No
proprietary source, personal profile/certificate, or raw system logs are included.
