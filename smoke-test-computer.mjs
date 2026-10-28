// Safe read-only checks for the desktop-control server. Does NOT drive the
// mouse/keyboard (that needs Accessibility and would disturb a live machine).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const transport = new StdioClientTransport({
  command: "node",
  args: [path.resolve("dist/computer-index.js")],
});
const client = new Client({ name: "smoke-computer", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("Tools:", tools.tools.map((t) => t.name).join(", "));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const img = r.content.find((c) => c.type === "image");
  console.log(`\n>>> ${name}(${JSON.stringify(args)})${r.isError ? " [ERROR]" : ""}`);
  console.log(txt + (img ? `\n[image: ${img.data.length} base64 chars]` : ""));
  return r;
};

await call("computer_screen_info");
await call("computer_cursor_position");
await call("check_setup");

await client.close();
console.log("\nDESKTOP SMOKE TEST DONE (read-only)");
process.exit(0);
