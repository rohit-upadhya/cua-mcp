#!/usr/bin/env node
// Single entry point for the published package.
//   npx cua-mcp browser    → run the browser MCP server (stdio)
//   npx cua-mcp computer    → run the desktop-control MCP server (stdio)
//   npx cua-mcp install     → register both servers with Claude Code (user scope)
//   npx cua-mcp help        → usage
import { execFileSync } from "node:child_process";

const cmd = (process.argv[2] || "browser").toLowerCase();

function printHelp() {
  process.stdout.write(
    `cua-mcp — drive a browser and your Mac desktop over MCP.

Usage:
  npx cua-mcp browser     Run the browser automation server (Mac/Win/Linux)
  npx cua-mcp computer     Run the desktop control server (macOS only)
  npx cua-mcp install     Register both with Claude Code (claude mcp add, user scope)
  npx cua-mcp help         Show this help

Manual wiring (any MCP client):
  claude mcp add cua --scope user --env CUA_HEADLESS=0 -- npx -y cua-mcp browser
  claude mcp add computer --scope user -- npx -y cua-mcp computer
`,
  );
}

function hasClaude(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function install() {
  if (!hasClaude()) {
    process.stdout.write(
      `Claude Code CLI not found. Add this to your MCP client config instead:\n\n` +
        JSON.stringify(
          {
            mcpServers: {
              cua: { command: "npx", args: ["-y", "cua-mcp", "browser"], env: { CUA_HEADLESS: "0" } },
              computer: { command: "npx", args: ["-y", "cua-mcp", "computer"] },
            },
          },
          null,
          2,
        ) +
        `\n\n(Claude Desktop config: ~/Library/Application Support/Claude/claude_desktop_config.json)\n`,
    );
    return;
  }
  const add = (name: string, extra: string[], serverArg: string) => {
    try {
      execFileSync(
        "claude",
        ["mcp", "add", name, "--scope", "user", ...extra, "--", "npx", "-y", "cua-mcp", serverArg],
        { stdio: "inherit" },
      );
    } catch {
      process.stderr.write(`Could not add "${name}" (it may already exist — remove it first with: claude mcp remove ${name}).\n`);
    }
  };
  add("cua", ["--env", "CUA_HEADLESS=0"], "browser");
  add("computer", [], "computer");
  process.stdout.write(
    `\nDone. Run 'claude mcp list' to verify.\n` +
      `macOS: the desktop server needs Screen Recording + Accessibility granted to your terminal/Claude host — run the 'check_setup' tool after.\n`,
  );
}

if (cmd === "browser") {
  await import("./index.js");
} else if (cmd === "computer") {
  await import("./computer-index.js");
} else if (cmd === "install") {
  install();
} else if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  printHelp();
} else {
  process.stderr.write(`Unknown command: ${cmd}\n\n`);
  printHelp();
  process.exit(1);
}
