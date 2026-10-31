#!/usr/bin/env python3
"""Build an isolated macOS capability probe; never installs or runs the app.

Without signing inputs, builds an ad-hoc app with no restricted entitlements.
A supplied Apple provisioning profile must grant Virtual HID to the exact bundle
ID before the restricted entitlement is added. Profiles remain in ignored output.
"""
import argparse
import datetime
import pathlib
import platform
import plistlib
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--identity", help="Apple signing identity (requires --profile)")
    parser.add_argument("--profile", type=pathlib.Path, help="Apple-issued macOS provisioning profile")
    parser.add_argument("--bundle-id", default="net.tobitti.codexdeck.hidprobe")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("CoreHID requires macOS 15 or newer and the macOS SDK")
    if bool(args.identity) != bool(args.profile):
        parser.error("--identity and --profile must be supplied together")
    if args.identity == "-":
        parser.error("an ad-hoc identity cannot authorize the restricted Virtual HID entitlement")

    entitlements = None
    if args.profile:
        # Validate before compiling/signing. Never print profile identities or certificates.
        decoded = subprocess.run(["security", "cms", "-D", "-i", str(args.profile.resolve())],
                                 check=True, capture_output=True).stdout
        profile = plistlib.loads(decoded)
        allowed = profile.get("Entitlements", {})
        if allowed.get("com.apple.developer.hid.virtual.device") is not True:
            parser.error("profile does not grant com.apple.developer.hid.virtual.device")
        team = allowed.get("com.apple.developer.team-identifier")
        app_id = allowed.get("com.apple.application-identifier")
        if not isinstance(team, str) or app_id != f"{team}.{args.bundle_id}":
            parser.error("profile must grant the exact --bundle-id; wildcard profiles are not accepted")
        if "OSX" not in profile.get("Platform", []):
            parser.error("profile must target macOS (OSX)")
        expires = profile.get("ExpirationDate")
        if not isinstance(expires, datetime.datetime) or expires.replace(tzinfo=datetime.timezone.utc) <= datetime.datetime.now(datetime.timezone.utc):
            parser.error("profile has expired or has no valid expiry")
        entitlements = {"com.apple.developer.hid.virtual.device": True,
                        "com.apple.developer.team-identifier": team,
                        "com.apple.application-identifier": app_id}

    repo = pathlib.Path(__file__).resolve().parent.parent
    app = repo / "outputs" / "virtual-hid-probe" / "CodexDeckHIDProbe.app"
    contents = app / "Contents"
    executable = contents / "MacOS" / "CodexDeckHIDProbe"
    executable.parent.mkdir(parents=True, exist_ok=True)
    # Prevent a previous signed build's profile from surviving in an ad-hoc build.
    embedded = contents / "embedded.provisionprofile"
    embedded.unlink(missing_ok=True)
    info = {"CFBundleIdentifier": args.bundle_id, "CFBundleExecutable": executable.name,
            "CFBundleName": "CodexDeckHIDProbe", "CFBundlePackageType": "APPL",
            "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0",
            "LSMinimumSystemVersion": "15.0", "LSUIElement": True}
    (contents / "Info.plist").write_bytes(plistlib.dumps(info))
    subprocess.run(["xcrun", "swiftc", "-parse-as-library", "-target", "arm64-apple-macos15.0" if
                    platform.machine() == "arm64" else "x86_64-apple-macos15.0",
                    str(repo / "scripts" / "probe-virtual-hid.swift"), "-o", str(executable)], check=True)
    command = ["codesign", "--force", "--sign", args.identity or "-", "--options", "runtime"]
    if entitlements:
        embedded.write_bytes(args.profile.read_bytes())
        entitlement_file = app.parent / "probe.entitlements.plist"
        entitlement_file.write_bytes(plistlib.dumps(entitlements))
        command += ["--timestamp", "--entitlements", str(entitlement_file)]
    subprocess.run([*command, str(app)], check=True)
    subprocess.run(["codesign", "--verify", "--strict", str(app)], check=True)
    print(f"Built {app}")
    print("Profile-backed Virtual HID entitlement supplied." if entitlements else
          "No Virtual HID entitlement: creation is expected to fail on a secured Mac.")
    print("This diagnostic does not use the Micro identity or send input reports. It has not been run.")


if __name__ == "__main__":
    main()
