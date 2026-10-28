import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const transport = new StdioClientTransport({
  command: "node",
  args: [path.resolve("dist/index.js")],
  env: { ...process.env, CUA_HEADLESS: "1" },
});

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("Tools:", tools.tools.map((t) => t.name).join(", "));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  const imgs = r.content.filter((c) => c.type === "image").length;
  console.log(`\n>>> ${name}(${JSON.stringify(args)})${r.isError ? " [ERROR]" : ""}`);
  console.log(txt + (imgs ? `\n[+${imgs} image(s)]` : ""));
  return r;
};

await call("browser_navigate", { url: "https://example.com" });
await call("browser_snapshot");
const shot = await call("browser_screenshot");
console.log("screenshot bytes(base64):", shot.content.find((c) => c.type === "image")?.data.length);
await call("browser_get_text");

// Real download test — a small file.
await call("browser_download", { url: "https://raw.githubusercontent.com/microsoft/playwright/main/README.md" });
await call("browser_list_downloads");

await call("browser_close");
await client.close();
console.log("\nSMOKE TEST OK");
process.exit(0);
