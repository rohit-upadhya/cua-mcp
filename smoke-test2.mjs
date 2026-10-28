// Tests the two paths the main smoke test skipped:
//   1. click-triggered download auto-save (the priority path)
//   2. HEADED launch, as spawned via .mcp.json
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const headless = process.env.TEST_HEADLESS ?? "0"; // default headed, like .mcp.json
const transport = new StdioClientTransport({
  command: "node",
  args: [path.resolve("dist/index.js")],
  env: { ...process.env, CUA_HEADLESS: headless, CUA_DOWNLOAD_DIR: path.resolve("test-downloads") },
});
const client = new Client({ name: "smoke2", version: "1.0.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const imgs = r.content.filter((c) => c.type === "image").length;
  console.log(`\n>>> ${name}(${JSON.stringify(args)})${r.isError ? " [ERROR]" : ""}`);
  console.log(txt + (imgs ? `\n[+${imgs} image(s)]` : ""));
  return r;
};

console.log(`Running HEADED=${headless === "0"}`);

// Headed launch + screenshot (confirms a window opens when spawned as subprocess)
await call("browser_navigate", { url: "https://example.com" });
await call("browser_screenshot");

// Click-triggered download: a page with a download link, no external site needed.
const html =
  "<a download='hi.txt' href='data:text/plain,hello world from a click'>download me</a>";
await call("browser_navigate", { url: "data:text/html," + encodeURIComponent(html) });
await call("browser_snapshot");
await call("browser_click", { ref: 0 });
await call("browser_wait_for", { seconds: 1 });
await call("browser_list_downloads");

await call("browser_close");
await client.close();
console.log("\nSMOKE TEST 2 DONE");
process.exit(0);
