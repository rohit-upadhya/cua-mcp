import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

// Single native CoreGraphics helper for the whole input path. `move`/`pos`/
// `screen` need no permission; `click`/`drag`/`scroll`/`type`/`key` post input
// events and require macOS Accessibility to take effect. Resolve it from the
// local dev build (dist/) or the shipped prebuilt universal binary (native/).
function resolveInputBin(): string {
  const here = path.dirname(fileURLToPath(import.meta.url)); // dist/
  const candidates = [
    path.join(here, "cua_input"), // dev: compiled next to the JS
    path.join(here, "..", "native", "cua_input"), // published: prebuilt universal
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}
const INPUT_BIN = resolveInputBin();

async function input(...args: string[]): Promise<string> {
  const { stdout } = await run(INPUT_BIN, args);
  return stdout.trim();
}

export interface ScreenInfo {
  /** Logical screen size (points) — the coordinate space the mouse uses. */
  width: number;
  height: number;
  /** Physical/logical ratio (2 on Retina). Screenshots are returned at logical size. */
  scale: number;
}

let tmpCounter = 0;
function tmpPath(suffix: string) {
  // Date.now() is unavailable in some harness contexts; a counter is enough.
  return path.join(tmpdir(), `cua-shot-${process.pid}-${tmpCounter++}-${suffix}`);
}

let cachedScale: number | null = null;
async function detectScale(logicalWidth: number): Promise<number> {
  if (cachedScale) return cachedScale;
  const phys = tmpPath("probe.png");
  try {
    await run("screencapture", ["-x", "-t", "png", phys]);
    const { stdout } = await run("sips", ["-g", "pixelWidth", phys]);
    const m = stdout.match(/pixelWidth:\s*(\d+)/);
    const physW = m ? Number(m[1]) : logicalWidth;
    cachedScale = Math.max(1, Math.round(physW / logicalWidth));
  } catch {
    cachedScale = 1;
  } finally {
    await unlink(phys).catch(() => {});
  }
  return cachedScale;
}

export async function screenInfo(): Promise<ScreenInfo> {
  const [w, h] = (await input("screen")).split(/\s+/).map(Number);
  const scale = await detectScale(w);
  return { width: w, height: h, scale };
}

/**
 * Full-screen PNG→JPEG downscaled to LOGICAL resolution, so pixel coordinates in
 * the image map 1:1 to the coordinates the mouse tools expect. Uses built-in
 * `screencapture` (respects Screen Recording permission) + `sips` (resize/encode).
 */
export async function screenshotLogical(
  quality = 70,
): Promise<{ base64: string; mimeType: string; info: ScreenInfo }> {
  const info = await screenInfo();
  const phys = tmpPath("full.png");
  const logical = tmpPath("logical.jpg");
  try {
    await run("screencapture", ["-x", "-t", "png", phys]);
    await run("sips", [
      "-z", String(info.height), String(info.width),
      "-s", "format", "jpeg",
      "-s", "formatOptions", String(quality),
      phys, "--out", logical,
    ]);
    const buf = await readFile(logical);
    return { base64: buf.toString("base64"), mimeType: "image/jpeg", info };
  } finally {
    await unlink(phys).catch(() => {});
    await unlink(logical).catch(() => {});
  }
}

export async function cursorPosition(): Promise<{ x: number; y: number }> {
  const [x, y] = (await input("pos")).split(/\s+/).map(Number);
  return { x, y };
}

export async function moveMouse(x: number, y: number) {
  await input("move", String(Math.round(x)), String(Math.round(y)));
}

export async function click(opts: { x?: number; y?: number; button?: string; double?: boolean }) {
  // If no coordinates, click at the current cursor position.
  let { x, y } = opts;
  if (x === undefined || y === undefined) {
    const p = await cursorPosition();
    x = p.x;
    y = p.y;
  }
  await input(
    "click",
    String(Math.round(x)),
    String(Math.round(y)),
    (opts.button || "left").toLowerCase(),
    opts.double ? "1" : "0",
  );
}

export async function drag(fromX: number, fromY: number, toX: number, toY: number) {
  await input("drag", String(Math.round(fromX)), String(Math.round(fromY)),
    String(Math.round(toX)), String(Math.round(toY)));
}

export async function scroll(direction: "up" | "down" | "left" | "right", amount: number) {
  const a = Math.max(1, Math.round(amount));
  let dx = 0, dy = 0;
  if (direction === "up") dy = a;
  else if (direction === "down") dy = -a;
  else if (direction === "right") dx = a;
  else dx = -a;
  await input("scroll", String(dx), String(dy));
}

export async function typeText(text: string) {
  await input("type", text);
}

/** Press a key or a combo like "cmd+space", "cmd+shift+4", "enter". */
export async function pressKeys(combo: string) {
  await input("key", combo);
}

export async function wait(seconds: number) {
  await new Promise((r) => setTimeout(r, Math.max(0, seconds) * 1000));
}

export interface SelfTestResult {
  ok: boolean;
  steps: string[];
  cursorMoved: boolean;
}

/**
 * Prove the control path without touching anything destructive: move the cursor
 * to a known point and read it back (same native coordinate space, so an exact
 * match is expected). Returns the cursor to where it started.
 */
export async function selfTest(): Promise<SelfTestResult> {
  const steps: string[] = [];
  const origin = await cursorPosition();
  steps.push(`Start cursor at (${origin.x}, ${origin.y}).`);

  const info = await screenInfo();
  const target = { x: Math.round(info.width / 2), y: Math.round(info.height / 2) };
  await moveMouse(target.x, target.y);
  await wait(0.2);
  const after = await cursorPosition();
  const dist = Math.hypot(after.x - target.x, after.y - target.y);
  const cursorMoved = dist <= 5;
  steps.push(
    `Moved to (${target.x}, ${target.y}); read back (${after.x}, ${after.y}) — ` +
      (cursorMoved ? "reached target ✓ cursor movement works." : "did not reach target ✗."),
  );

  await moveMouse(origin.x, origin.y);
  steps.push(`Returned cursor to (${origin.x}, ${origin.y}).`);

  return { ok: cursorMoved, steps, cursorMoved };
}

// ── Permissions (macOS TCC) ────────────────────────────────────────────────

export interface PermissionStatus {
  accessibility: string;
  screen: string;
}

export async function permissionStatus(): Promise<PermissionStatus> {
  try {
    const perms = (await import("node-mac-permissions")) as any;
    const p = perms.default ?? perms;
    return {
      accessibility: p.getAuthStatus("accessibility"),
      screen: p.getAuthStatus("screen"),
    };
  } catch {
    return { accessibility: "unknown", screen: "unknown" };
  }
}

/** Pop the system prompts / open the right Settings panes for missing perms. */
export async function requestPermissions(): Promise<void> {
  try {
    const perms = (await import("node-mac-permissions")) as any;
    const p = perms.default ?? perms;
    if (p.getAuthStatus("accessibility") !== "authorized") p.askForAccessibilityAccess();
    if (p.getAuthStatus("screen") !== "authorized") p.askForScreenCaptureAccess?.();
  } catch {
    // no-op if the module isn't available
  }
}
