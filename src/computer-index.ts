#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as pc from "./computer.js";

const server = new McpServer({ name: "cua-computer", version: "1.0.0" });

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

// ── Setup / permissions ───────────────────────────────────────────────────────

server.registerTool(
  "check_setup",
  {
    title: "Check setup & permissions",
    description:
      "Report macOS Screen Recording + Accessibility permission status and return a live screenshot. If the screenshot shows only your wallpaper (no windows/menu bar), Screen Recording is NOT working — grant it and restart the host app. Run this first.",
    inputSchema: {
      request: z
        .boolean()
        .optional()
        .describe("If true, pop the macOS permission prompts / open Settings for anything missing."),
    },
  },
  async ({ request }) => {
    try {
      if (request) await pc.requestPermissions();
      const status = await pc.permissionStatus();
      const { base64, mimeType, info } = await pc.screenshotLogical();
      const note =
        `Accessibility (mouse/keyboard): reported ${status.accessibility}\n` +
        `Screen Recording (screenshots): reported ${status.screen} ` +
        `(trust the image below, not this line — a wallpaper-only capture means it's really off)\n` +
        `Main display: ${info.width}x${info.height} logical (scale ${info.scale}x). Multi-monitor: main display only.\n\n` +
        `Look at the screenshot below: if you can see your actual windows, Screen Recording works. ` +
        `If it's only the desktop wallpaper, grant Screen Recording to your terminal/Claude host in ` +
        `System Settings › Privacy & Security › Screen Recording, then fully restart that app.`;
      return {
        content: [
          { type: "text" as const, text: note },
          { type: "image" as const, data: base64, mimeType },
        ],
      };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "self_test",
  {
    title: "Self-test the control path",
    description:
      "Non-destructive end-to-end check: reports permissions, moves the cursor to screen center and reads it back to prove input is delivered, returns the cursor, and attaches a screenshot. Run after granting permissions.",
    inputSchema: {},
  },
  async () => {
    try {
      const status = await pc.permissionStatus();
      const result = await pc.selfTest();
      const { base64, mimeType, info } = await pc.screenshotLogical();
      const clicksOk = status.accessibility === "authorized";

      let verdict: string;
      if (!result.cursorMoved) {
        verdict = "FAIL — cursor did not move at all. Unexpected; check the move_mouse binary built.";
      } else if (clicksOk) {
        verdict = "PASS — full control: mouse moves, clicks, and typing all available.";
      } else {
        verdict =
          "PARTIAL — mouse MOVEMENT works (no permission needed), but CLICKS and TYPING " +
          "require Accessibility, which is currently denied. Grant it in System Settings › " +
          "Privacy & Security › Accessibility and restart the host app to enable clicks/keys.";
      }
      const report =
        `Permissions — accessibility: ${status.accessibility}, screen: ${status.screen}\n` +
        `Screen: ${info.width}x${info.height} logical (scale ${info.scale}x)\n\n` +
        result.steps.map((s) => `• ${s}`).join("\n") +
        `\n\nRESULT: ${verdict}` +
        `\n(Screenshot below confirms Screen Recording: real windows = working, wallpaper-only = denied.)`;
      return {
        content: [
          { type: "text" as const, text: report },
          { type: "image" as const, data: base64, mimeType },
        ],
        isError: !result.cursorMoved,
      };
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Observation ───────────────────────────────────────────────────────────────

server.registerTool(
  "computer_screenshot",
  {
    title: "Screenshot the whole screen",
    description:
      "Capture the entire screen as a PNG, downscaled to logical resolution so pixel coordinates in the image map 1:1 to the coordinates computer_click/computer_move expect. Take this before clicking so you can see where things are.",
    inputSchema: {},
  },
  async () => {
    try {
      const { base64, mimeType, info } = await pc.screenshotLogical();
      return {
        content: [
          { type: "text" as const, text: `Screen ${info.width}x${info.height} (logical; use these coordinates).` },
          { type: "image" as const, data: base64, mimeType },
        ],
      };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "computer_screen_info",
  {
    title: "Screen info",
    description: "Return the logical screen size (the coordinate space for clicks) and the Retina scale factor.",
    inputSchema: {},
  },
  async () => {
    try {
      const info = await pc.screenInfo();
      return text(`Logical size: ${info.width}x${info.height}\nScale: ${info.scale}x`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "computer_cursor_position",
  { title: "Cursor position", description: "Return the current mouse position (logical coordinates).", inputSchema: {} },
  async () => {
    try {
      const p = await pc.cursorPosition();
      return text(`Cursor at (${p.x}, ${p.y})`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Mouse ───────────────────────────────────────────────────────────────────

server.registerTool(
  "computer_move",
  {
    title: "Move mouse",
    description: "Move the mouse to logical coordinates (from a screenshot). Does not click.",
    inputSchema: { x: z.number().describe("X in logical pixels."), y: z.number().describe("Y in logical pixels.") },
  },
  async ({ x, y }) => {
    try {
      await pc.moveMouse(x, y);
      return text(`Moved to (${x}, ${y}).`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "computer_click",
  {
    title: "Click",
    description:
      "Click at logical coordinates (if given) or at the current position. Supports left/right/middle button and double-click.",
    inputSchema: {
      x: z.number().optional().describe("X in logical pixels."),
      y: z.number().optional().describe("Y in logical pixels."),
      button: z.enum(["left", "right", "middle"]).optional().describe("Default left."),
      double: z.boolean().optional().describe("Double-click. Default false."),
    },
  },
  async ({ x, y, button, double }) => {
    try {
      await pc.click({ x, y, button, double });
      const at = x !== undefined && y !== undefined ? ` at (${x}, ${y})` : "";
      return text(`${double ? "Double-c" : "C"}licked ${button ?? "left"}${at}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "computer_drag",
  {
    title: "Drag",
    description: "Press the left button at one point, drag to another, and release. Logical coordinates.",
    inputSchema: {
      fromX: z.number(),
      fromY: z.number(),
      toX: z.number(),
      toY: z.number(),
    },
  },
  async ({ fromX, fromY, toX, toY }) => {
    try {
      await pc.drag(fromX, fromY, toX, toY);
      return text(`Dragged (${fromX}, ${fromY}) → (${toX}, ${toY}).`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "computer_scroll",
  {
    title: "Scroll",
    description: "Scroll the mouse wheel in a direction by an amount (wheel steps).",
    inputSchema: {
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().optional().describe("Wheel steps. Default 5."),
    },
  },
  async ({ direction, amount }) => {
    try {
      await pc.scroll(direction, amount ?? 5);
      return text(`Scrolled ${direction}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Keyboard ──────────────────────────────────────────────────────────────────

server.registerTool(
  "computer_type",
  {
    title: "Type text",
    description: "Type a string of text at the current focus (as if typed on the keyboard).",
    inputSchema: { text: z.string().describe("Text to type.") },
  },
  async ({ text: t }) => {
    try {
      await pc.typeText(t);
      return text(`Typed ${t.length} chars.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "computer_key",
  {
    title: "Press key / shortcut",
    description:
      'Press a key or shortcut combo. Examples: "enter", "escape", "cmd+space" (Spotlight), "cmd+c", "cmd+shift+4", "cmd+tab", "pagedown".',
    inputSchema: { keys: z.string().describe('Key or combo joined with "+".') },
  },
  async ({ keys }) => {
    try {
      await pc.pressKeys(keys);
      return text(`Pressed ${keys}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "computer_wait",
  {
    title: "Wait",
    description: "Pause for a number of seconds (e.g. to let an app open or a UI settle).",
    inputSchema: { seconds: z.number().describe("Seconds to wait.") },
  },
  async ({ seconds }) => {
    try {
      await pc.wait(seconds);
      return text(`Waited ${seconds}s.`);
    } catch (e) {
      return fail(e);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("cua-computer (desktop control) server running on stdio\n");
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
