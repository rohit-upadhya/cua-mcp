// Runs after `npm install` / `npx`. Best-effort and non-fatal: a failure here
// must not break install. Downloads Chromium for the browser server, and on
// macOS (re)builds the native input helper (falls back to the shipped prebuilt).
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (m) => process.stdout.write(`cua-mcp postinstall: ${m}\n`);

// 1) Chromium for the Playwright browser server (skippable).
if (process.env.CUA_SKIP_BROWSER !== "1") {
  try {
    execSync("playwright install chromium", { stdio: "inherit", cwd: root });
  } catch {
    log("could not install Chromium — run `npx playwright install chromium` if you need the browser server.");
  }
}

// 2) macOS native input helper (no-op elsewhere).
try {
  execSync(`node "${path.join(root, "scripts", "build-native.mjs")}"`, { stdio: "inherit" });
} catch {
  log("native helper build step skipped.");
}
