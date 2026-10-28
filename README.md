# cua-mcp

Two MCP servers that let a Claude Code agent (or any MCP client) **drive your
machine**:

1. **`cua` — browser control** (Playwright). Precise web automation: navigate,
   read, screenshot, click/type by element, and download files. Best for web tasks.
2. **`computer` — whole-computer control** (screenshot + mouse + keyboard). Drives
   **any app on your desktop** — Finder, native apps, menus — by looking at a
   screenshot and moving the real mouse/keyboard. macOS.

Use the browser server when the task is on the web (more reliable, element-level
precision). Use the computer server when you need to leave the browser and touch
the rest of the OS.

> Off-the-shelf alternatives exist ([`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)
> for the browser; Anthropic's computer-use reference for a sandboxed VM). These
> are lean custom builds so you control the tool surface and drive your *actual* machine.

## Install (one command)

Once published to npm (see **Publishing** below), anyone registers both servers
with Claude Code in a single step — no clone, no compiler needed (a prebuilt
universal macOS binary ships in the package):

```bash
npx -y cua-mcp install
```

That runs `claude mcp add` for both at user scope (available in every session).
Or wire them manually:

```bash
claude mcp add cua --scope user --env CUA_HEADLESS=0 -- npx -y cua-mcp browser
claude mcp add computer --scope user -- npx -y cua-mcp computer
```

**Claude Desktop / other MCP clients** — add to the client's config:

```json
{
  "mcpServers": {
    "cua": { "command": "npx", "args": ["-y", "cua-mcp", "browser"], "env": { "CUA_HEADLESS": "0" } },
    "computer": { "command": "npx", "args": ["-y", "cua-mcp", "computer"] }
  }
}
```

`claude mcp list` should show both; `/mcp` inside a session lists the tools.
First run downloads Chromium (for the browser server) automatically.

## Develop from source

```bash
git clone <repo> && cd cua-mcp
npm install    # deps + Chromium + compiles the native helper
npm run build  # compiles TypeScript to dist/ and native/cua_input
```

A `.mcp.json` pointing at the local `dist/` is included, so a Claude Code session
started in the folder picks up both servers automatically.

---

## ⚠️ macOS permissions (required for the `computer` server)

The desktop server needs two permissions, granted to **the app that runs Claude
Code** (your terminal — Terminal/iTerm — or the Claude app), **not** to `node`:

- **Screen Recording** → so screenshots capture window contents (not just wallpaper).
- **Accessibility** → so synthetic mouse/keyboard events are delivered.

Grant both in **System Settings › Privacy & Security**, then **fully quit and
reopen** that app (the permission only takes effect after restart).

**These fail silently.** Without Screen Recording you get a screenshot of only
your wallpaper; without Accessibility, clicks/keystrokes do nothing with no error.
So the first thing to run is **`check_setup`** — it reports both statuses *and*
returns a live screenshot: if you see your real windows, Screen Recording works;
if it's just wallpaper, it isn't. Pass `request: true` to pop the system prompts.

---

## `computer` — whole-computer tools

> **Implementation:** the whole input path is one dependency-free native helper
> (`cua_input`, CoreGraphics, built from `cua_input.c` during `npm run build`) —
> no nut.js/pyautogui. `computer_move` uses a cursor *warp* that needs **no
> permissions**, so it works immediately. **Clicks and typing** post input events
> and require **Accessibility** (any tool — native, pyautogui, nut.js — needs it;
> it's a macOS boundary, not a library limitation). Typing uses Unicode events,
> so it's keyboard-layout independent.

| Tool | What it does |
|------|--------------|
| `check_setup` | Report permissions + return a screenshot to confirm they work. **Run first.** |
| `self_test` | Non-destructive: moves the cursor to center and reads it back (proves movement), reports whether clicks/typing are enabled, returns a screenshot. |
| `computer_screenshot` | Screenshot the whole screen (JPEG, logical resolution — pixel coords map 1:1 to clicks) |
| `computer_screen_info` | Logical screen size + Retina scale |
| `computer_cursor_position` | Current mouse position |
| `computer_move` | Move mouse to (x, y) |
| `computer_click` | Click at (x, y); left/right/middle, optional double |
| `computer_drag` | Press, drag, release between two points |
| `computer_scroll` | Scroll up/down/left/right |
| `computer_type` | Type a string |
| `computer_key` | Press a key/combo: `cmd+space`, `cmd+c`, `cmd+shift+4`, `enter`, `escape` |
| `computer_wait` | Pause N seconds |

**The loop the agent runs:** `computer_screenshot` → look at it → `computer_click`/
`computer_type` at the coordinates it sees → screenshot again to confirm. All
coordinates are in **logical pixels** (same space the screenshot is shown in), so
there's no scaling math — Retina is handled for you. *Multi-monitor: the main
display only.*

**First self-test** (after granting Accessibility + restarting the host):
`computer_move {x:100,y:100}` → `computer_cursor_position` should echo ~(100,100)
— that proves the control coordinate space with nothing destructive. Then one
`computer_click` on a visible element + `computer_screenshot` to confirm it landed.

Example ask:

> "Open Spotlight, launch Notes, and type a shopping list." → the agent does
> `computer_key cmd+space`, `computer_type "Notes"`, `computer_key enter`, then types.

## `cua` — browser tools

| Tool | What it does |
|------|--------------|
| `browser_navigate` | Open a URL (launches the browser on first use) |
| `browser_back` | Previous page |
| `browser_snapshot` | List interactive elements with stable `[ref=N]` handles — **call first**, then click/type by ref |
| `browser_screenshot` | PNG of the viewport (or `fullPage`) |
| `browser_get_text` | Visible text of the page or a selector |
| `browser_click` | Click by `ref` (preferred) or visible `text` |
| `browser_type` | Type into a field by `ref`/`text`, optional `submit` |
| `browser_press_key` / `browser_scroll` / `browser_wait_for` | Keyboard / scroll / wait |
| `browser_download` | Download a file directly from a URL (any content-type) |
| `browser_list_downloads` | List everything downloaded this session + saved paths |
| `browser_tabs` / `browser_new_tab` / `browser_select_tab` | Tabs |
| `browser_evaluate` | Run JS in the page |
| `browser_close` | Close the browser |

**Downloads** save to `CUA_DOWNLOAD_DIR` (default `~/Downloads/cua-mcp`): any
click/link that triggers a download is auto-saved, and `browser_download { url }`
fetches a file directly. `browser_list_downloads` returns the saved paths.

## Config (env vars)

| Var | Server | Default | Meaning |
|-----|--------|---------|---------|
| `CUA_HEADLESS` | cua | `0` (headed) | `1` = no visible browser window |
| `CUA_DOWNLOAD_DIR` | cua | `~/Downloads/cua-mcp` | where downloads are saved |
| `CUA_SKIP_BROWSER` | install | — | `1` skips the Chromium download on install |

## Publishing (maintainer)

The package is publish-ready: `npm run build` produces `dist/` + a **universal**
(arm64 + x86_64) `native/cua_input`, and `files` ships only what's needed
(~28 kB; Chromium is fetched on the user's machine at install, not bundled).

```bash
npm login
npm publish --access public   # prepublishOnly runs the build for you
```

The name `cua-mcp` is currently free on npm. If you fork under your own name, use
a scoped package (`@you/cua-mcp`) and update the `npx` commands above to match.
Cross-platform note: the browser server runs on Mac/Windows/Linux; the desktop
server is **macOS-only** (native CoreGraphics + `screencapture`). On other OSes
the install still succeeds and the browser server works; desktop tools are inert.

## What was verified

- **Browser server:** navigate, snapshot, screenshot (image), direct + click-triggered
  downloads (real files on disk), headed launch, tabs — all exercised end-to-end.
- **Computer server:** native `cua_input` helper compiles clean (`-Wall`); screen
  geometry + Retina scale (2×), cursor read, screenshot pipeline (JPEG, logical
  res), and **live cursor movement all verified** via `self_test` (moved to
  center and back, no permissions). `click`/`drag`/`scroll`/`type`/`key` are
  **implemented and run without crashing, but are unverified pending Accessibility**
  (events are silently dropped until it's granted). After granting it + restarting
  the host, confirm with: `self_test` → PASS, one `computer_click` on a target,
  and `computer_key cmd+space` (Spotlight opens = the shortcut/keycode path works).
