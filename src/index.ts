#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { manager, type SnapshotNode } from "./browser.js";

const server = new McpServer({
  name: "cua-mcp",
  version: "1.0.0",
});

/** Plain-text tool result. */
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** Error result (so the model sees the message instead of a transport crash). */
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

function formatSnapshot(nodes: SnapshotNode[]): string {
  if (nodes.length === 0) return "(no interactive elements found)";
  return nodes
    .map((n) => {
      const val = n.value ? ` value="${n.value}"` : "";
      return `[ref=${n.ref}] ${n.role} "${n.name}"${val}`;
    })
    .join("\n");
}

// ── Navigation ──────────────────────────────────────────────────────────────

server.registerTool(
  "browser_navigate",
  {
    title: "Navigate",
    description:
      "Open a URL in the browser (launches the browser on first use). Returns the resolved URL and page title.",
    inputSchema: {
      url: z.string().describe("The URL to open, e.g. https://example.com"),
      waitUntil: z
        .enum(["load", "domcontentloaded", "networkidle"])
        .optional()
        .describe("When to consider navigation done. Default domcontentloaded."),
    },
  },
  async ({ url, waitUntil }) => {
    try {
      const page = await manager.page();
      await page.goto(url, { waitUntil: waitUntil ?? "domcontentloaded" });
      return text(`Navigated to ${page.url()}\nTitle: ${await page.title()}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "browser_back",
  { title: "Go back", description: "Go back to the previous page.", inputSchema: {} },
  async () => {
    try {
      const page = manager.activePage();
      await page.goBack();
      return text(`Back to ${page.url()}`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Observation ───────────────────────────────────────────────────────────────

server.registerTool(
  "browser_snapshot",
  {
    title: "Snapshot interactive elements",
    description:
      "List the clickable/typable elements on the current page, each with a stable [ref=N], role and accessible name. Call this first, then pass a ref to browser_click / browser_type. Preferred over guessing CSS selectors.",
    inputSchema: {},
  },
  async () => {
    try {
      const page = manager.activePage();
      const nodes = await manager.snapshot();
      return text(`URL: ${page.url()}\n\n${formatSnapshot(nodes)}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "browser_screenshot",
  {
    title: "Screenshot",
    description:
      "Capture the current page as a PNG image so you can see it. Defaults to the visible viewport (keeps context small); set fullPage for the whole scrollable page.",
    inputSchema: {
      fullPage: z.boolean().optional().describe("Capture the entire scrollable page. Default false."),
    },
  },
  async ({ fullPage }) => {
    try {
      const page = manager.activePage();
      const buf = await page.screenshot({ fullPage: fullPage ?? false, type: "png" });
      return {
        content: [
          { type: "text" as const, text: `Screenshot of ${page.url()}` },
          { type: "image" as const, data: buf.toString("base64"), mimeType: "image/png" },
        ],
      };
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "browser_get_text",
  {
    title: "Get page text",
    description: "Return the visible text of the page (or of a CSS selector if given). Useful for reading content.",
    inputSchema: {
      selector: z.string().optional().describe("Optional CSS selector to scope the text."),
    },
  },
  async ({ selector }) => {
    try {
      const page = manager.activePage();
      const content = selector
        ? await page.locator(selector).first().innerText()
        : await page.evaluate(() => document.body.innerText);
      return text(content.slice(0, 20000));
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Interaction ───────────────────────────────────────────────────────────────

server.registerTool(
  "browser_click",
  {
    title: "Click",
    description:
      "Click an element. Prefer `ref` from browser_snapshot; otherwise match by visible `text`. If the click triggers a download it is saved automatically (see browser_list_downloads).",
    inputSchema: {
      ref: z.number().optional().describe("Element ref from browser_snapshot."),
      text: z.string().optional().describe("Visible text of the element, if no ref."),
    },
  },
  async ({ ref, text: t }) => {
    try {
      const page = manager.activePage();
      await manager.locator(page, { ref, text: t }).click({ timeout: 15000 });
      await page.waitForTimeout(400); // let navigation/download settle
      await manager.syncTabs();
      return text(`Clicked. Current URL: ${manager.activePage().url()}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "browser_type",
  {
    title: "Type text",
    description: "Type text into an input/textarea. Prefer `ref` from browser_snapshot; set submit to press Enter after.",
    inputSchema: {
      value: z.string().describe("Text to type."),
      ref: z.number().optional().describe("Element ref from browser_snapshot."),
      text: z.string().optional().describe("Visible label/placeholder of the field, if no ref."),
      submit: z.boolean().optional().describe("Press Enter after typing. Default false."),
    },
  },
  async ({ value, ref, text: t, submit }) => {
    try {
      const page = manager.activePage();
      const loc = manager.locator(page, { ref, text: t });
      await loc.fill(value, { timeout: 15000 });
      if (submit) {
        await loc.press("Enter");
        await page.waitForTimeout(400);
      }
      return text(`Typed into element. Current URL: ${page.url()}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "browser_press_key",
  {
    title: "Press key",
    description: "Press a keyboard key globally, e.g. Enter, Escape, ArrowDown, PageDown, Tab.",
    inputSchema: { key: z.string().describe("Key name, e.g. Enter, Escape, PageDown.") },
  },
  async ({ key }) => {
    try {
      const page = manager.activePage();
      await page.keyboard.press(key);
      await page.waitForTimeout(200);
      return text(`Pressed ${key}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "browser_scroll",
  {
    title: "Scroll",
    description: "Scroll the page up or down by roughly one viewport (or a given pixel amount).",
    inputSchema: {
      direction: z.enum(["down", "up"]).describe("Scroll direction."),
      amount: z.number().optional().describe("Pixels to scroll. Default ~one viewport."),
    },
  },
  async ({ direction, amount }) => {
    try {
      const page = manager.activePage();
      const dy = (amount ?? 700) * (direction === "up" ? -1 : 1);
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(300);
      return text(`Scrolled ${direction}.`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "browser_wait_for",
  {
    title: "Wait",
    description: "Wait for text to appear on the page, or for a fixed number of seconds.",
    inputSchema: {
      text: z.string().optional().describe("Text to wait for."),
      seconds: z.number().optional().describe("Seconds to wait (used if no text)."),
    },
  },
  async ({ text: t, seconds }) => {
    try {
      const page = manager.activePage();
      if (t) {
        await page.getByText(t, { exact: false }).first().waitFor({ timeout: 30000 });
        return text(`Found "${t}".`);
      }
      await page.waitForTimeout((seconds ?? 1) * 1000);
      return text(`Waited ${seconds ?? 1}s.`);
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Downloads ─────────────────────────────────────────────────────────────────

server.registerTool(
  "browser_download",
  {
    title: "Download from URL",
    description:
      "Download a file directly from a URL (does not need to be a page). Saved to the download directory; returns the saved path.",
    inputSchema: { url: z.string().describe("Direct URL of the file to download.") },
  },
  async ({ url }) => {
    try {
      const rec = await manager.downloadUrl(url);
      return text(`Downloaded ${rec.filename}\nSaved to: ${rec.path}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "browser_list_downloads",
  {
    title: "List downloads",
    description:
      "List every file downloaded this session (from any click or direct download), with filename, saved path, and source URL.",
    inputSchema: {},
  },
  async () => {
    await manager.settleDownloads(); // wait out any in-flight save from a recent click
    if (manager.downloads.length === 0) {
      return text(`No downloads yet. Files save to: ${manager.downloadDir}`);
    }
    const lines = manager.downloads.map(
      (d, i) => `${i + 1}. ${d.filename}\n   path: ${d.path}\n   from: ${d.url}`,
    );
    return text(`Download directory: ${manager.downloadDir}\n\n${lines.join("\n")}`);
  },
);

// ── Tabs & JS ───────────────────────────────────────────────────────────────

server.registerTool(
  "browser_tabs",
  { title: "List tabs", description: "List open tabs with their index, URL and title.", inputSchema: {} },
  async () => {
    try {
      const tabs = await manager.listPages();
      return text(
        tabs.map((t) => `${t.active ? "*" : " "} [${t.index}] ${t.title} — ${t.url}`).join("\n") || "(no tabs)",
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "browser_new_tab",
  {
    title: "New tab",
    description: "Open a new tab and make it active. Optionally navigate to a URL.",
    inputSchema: { url: z.string().optional().describe("Optional URL to open.") },
  },
  async ({ url }) => {
    try {
      const page = await manager.newTab(url);
      return text(`Opened tab. URL: ${page.url()}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "browser_select_tab",
  {
    title: "Select tab",
    description: "Switch the active tab by index (see browser_tabs).",
    inputSchema: { index: z.number().describe("Tab index.") },
  },
  async ({ index }) => {
    try {
      await manager.syncTabs();
      manager.selectTab(index);
      return text(`Active tab is now ${index}: ${manager.activePage().url()}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "browser_evaluate",
  {
    title: "Evaluate JS",
    description:
      "Run a JavaScript expression in the page and return its result as JSON. Use for reading values or advanced interactions.",
    inputSchema: { script: z.string().describe("A JS expression or function body returning a value.") },
  },
  async ({ script }) => {
    try {
      const page = manager.activePage();
      const result = await page.evaluate(
        (code) => {
          // eslint-disable-next-line no-new-func
          const fn = new Function(`return (async () => { ${code} })()`);
          return fn();
        },
        script.includes("return") ? script : `return (${script})`,
      );
      return text(JSON.stringify(result, null, 2) ?? "undefined");
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "browser_close",
  {
    title: "Close browser",
    description: "Close the browser and free resources. A later navigate relaunches it.",
    inputSchema: {},
  },
  async () => {
    try {
      await manager.close();
      return text("Browser closed.");
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("cua-mcp server running on stdio\n");
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
