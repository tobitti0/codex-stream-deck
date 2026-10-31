import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// A Windows build keeps the native Windows connection and does not bundle a
// nonfunctional helper. macOS packages contain both supported architectures.
export async function buildMacControls(bin) {
  if (process.platform !== "darwin") return;
  const contents = resolve(bin, "Codex Deck Controls.app/Contents");
  const executable = resolve(contents, "MacOS/CodexDeckControls");
  const cache = resolve("outputs/macos-controls");
  await mkdir(resolve(contents, "MacOS"), { recursive: true });
  await mkdir(cache, { recursive: true });
  const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  await writeFile(resolve(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>net.tobitti.codexdeck.controls</string>
<key>CFBundleName</key><string>Codex Deck Controls</string>
<key>CFBundleDisplayName</key><string>Codex Deck Controls</string>
<key>CFBundleExecutable</key><string>CodexDeckControls</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${Number(version.replace(/\D/g, ""))}</string>
<key>CFBundleShortVersionString</key><string>${version.split("-")[0]}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`);
  const slices = [];
  const source = await readFile(resolve("native/CodexDeckControls.swift"));
  const compiler = execFileSync("xcrun", ["swiftc", "--version"], { encoding: "utf8" });
  const sdk = execFileSync("xcrun", ["--show-sdk-version"], { encoding: "utf8" });
  const fingerprint = createHash("sha256").update(source).update(compiler).update(sdk).update("-O-macosx13.0").digest("hex").slice(0, 16);
  for (const arch of ["arm64", "x86_64"]) {
    const output = resolve(cache, `CodexDeckControls-${arch}-${fingerprint}`); slices.push(output);
    if (!existsSync(output)) execFileSync("/usr/bin/nice", ["-n", "10", "xcrun", "swiftc", "-O", "-target", `${arch}-apple-macosx13.0`, "native/CodexDeckControls.swift", "-o", output], { stdio: "inherit" });
  }
  execFileSync("xcrun", ["lipo", "-create", ...slices, "-output", executable], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "net.tobitti.codexdeck.controls", resolve(contents, "..")], { stdio: "inherit" });
  execFileSync(executable, ["--self-test"], { stdio: "inherit" });
}
