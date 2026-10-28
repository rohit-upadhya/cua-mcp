// Compiles the native input helper to native/cua_input. Universal (arm64 +
// x86_64) when possible so both Apple Silicon and Intel Macs run the same
// prebuilt. No-op on non-macOS. Shared by `npm run build` and postinstall.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (os.platform() !== "darwin") {
  console.log("build-native: skipped (not macOS; desktop server is macOS-only).");
  process.exit(0);
}

const src = path.join(root, "cua_input.c");
const outDir = path.join(root, "native");
const out = path.join(outDir, "cua_input");
const frameworks = "-framework ApplicationServices -framework CoreFoundation";
mkdirSync(outDir, { recursive: true });

if (!existsSync(src)) {
  console.log("build-native: cua_input.c not found; keeping any existing prebuilt.");
  process.exit(0);
}

try {
  execSync(`clang -arch arm64 -arch x86_64 ${frameworks} "${src}" -o "${out}"`, { stdio: "ignore" });
  console.log("build-native: compiled universal (arm64 + x86_64).");
} catch {
  try {
    execSync(`clang ${frameworks} "${src}" -o "${out}"`, { stdio: "ignore" });
    console.log("build-native: compiled for host arch (universal failed).");
  } catch {
    if (existsSync(out)) console.log("build-native: no compiler; keeping shipped prebuilt.");
    else console.log("build-native: WARNING no compiler and no prebuilt — desktop control unavailable.");
  }
}
