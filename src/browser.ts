import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface DownloadRecord {
  filename: string;
  path: string;
  url: string;
  startedAt: string;
}

/**
 * Snapshot of a single interactive element, tagged with a stable `ref`
 * that the agent can pass back to click/type without guessing CSS selectors.
 */
export interface SnapshotNode {
  ref: number;
  role: string;
  name: string;
  tag: string;
  value?: string;
}

const REF_ATTR = "data-cua-ref";

/**
 * Owns the one long-lived browser for the whole MCP process. Every tool call
 * routes through here so page state (logins, cookies, the current URL) and the
 * download history survive across calls.
 */
class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Page[] = [];
  private activeIndex = 0;

  readonly downloads: DownloadRecord[] = [];
  readonly downloadDir: string;
  private pendingDownloads = 0;
  private readonly headless: boolean;

  constructor() {
    this.downloadDir =
      process.env.CUA_DOWNLOAD_DIR ||
      path.join(homedir(), "Downloads", "cua-mcp");
    // Default to headed so the user can watch; set CUA_HEADLESS=1 for CI/servers.
    this.headless = process.env.CUA_HEADLESS === "1";
  }

  private async ensure(): Promise<Page> {
    if (this.browser && this.context && this.pages.length > 0) {
      return this.activePage();
    }
    await mkdir(this.downloadDir, { recursive: true });

    this.browser = await chromium.launch({ headless: this.headless });
    this.context = await this.browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1280, height: 800 },
    });

    // Persistent handler: ANY download, however it was triggered (a click, a
    // direct link, JS), is auto-saved and recorded. The agent never has to
    // predict in advance whether an action downloads something. This fires for
    // every page in the context — including ones we open via newPage() and
    // popups the site opens — so it's the single place downloads are wired.
    this.context.on("page", (p) => this.wireDownloads(p));

    const page = await this.context.newPage();
    this.pages = [page];
    this.activeIndex = 0;
    return page;
  }

  private wireDownloads(page: Page) {
    page.on("download", async (download) => {
      this.pendingDownloads++;
      const suggested = download.suggestedFilename() || "download";
      const dest = path.join(this.downloadDir, this.uniqueName(suggested));
      try {
        await download.saveAs(dest);
        this.downloads.push({
          filename: path.basename(dest),
          path: dest,
          url: download.url(),
          startedAt: new Date().toISOString(),
        });
      } catch {
        // Download may be cancelled by the page; ignore silently.
      } finally {
        this.pendingDownloads--;
      }
    });
  }

  /** Block until in-flight downloads finish saving (bounded), so a list right
   * after a click doesn't miss a large file still being written. */
  async settleDownloads(timeoutMs = 60000): Promise<void> {
    const step = 200;
    let waited = 0;
    while (this.pendingDownloads > 0 && waited < timeoutMs) {
      await new Promise((r) => setTimeout(r, step));
      waited += step;
    }
  }

  private uniqueName(name: string): string {
    const taken = new Set(this.downloads.map((d) => path.basename(d.path)));
    if (!taken.has(name)) return name;
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    let i = 1;
    while (taken.has(`${base} (${i})${ext}`)) i++;
    return `${base} (${i})${ext}`;
  }

  async page(): Promise<Page> {
    return this.ensure();
  }

  activePage(): Page {
    if (this.pages.length === 0) throw new Error("No open page. Navigate first.");
    return this.pages[Math.min(this.activeIndex, this.pages.length - 1)];
  }

  async listPages(): Promise<{ index: number; url: string; title: string; active: boolean }[]> {
    await this.ensure();
    const out = [];
    for (let i = 0; i < this.pages.length; i++) {
      out.push({
        index: i,
        url: this.pages[i].url(),
        title: await this.pages[i].title().catch(() => ""),
        active: i === this.activeIndex,
      });
    }
    return out;
  }

  async newTab(url?: string): Promise<Page> {
    await this.ensure();
    const page = await this.context!.newPage(); // download handler attached via context "page" event
    this.pages.push(page);
    this.activeIndex = this.pages.length - 1;
    if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
    return page;
  }

  selectTab(index: number) {
    if (index < 0 || index >= this.pages.length) {
      throw new Error(`No tab at index ${index}. Open tabs: 0-${this.pages.length - 1}.`);
    }
    this.activeIndex = index;
  }

  /** Refresh tab bookkeeping after tabs may have closed on their own. */
  async syncTabs() {
    if (!this.context) return;
    this.pages = this.context.pages();
    if (this.activeIndex >= this.pages.length) this.activeIndex = this.pages.length - 1;
  }

  /**
   * Tag every interactive element with a fresh ref and return the list. This is
   * what makes the browser usable by an LLM: it gets stable handles (role +
   * accessible name + ref) instead of being asked to invent CSS selectors.
   */
  async snapshot(): Promise<SnapshotNode[]> {
    const page = await this.ensure();
    return page.evaluate((refAttr) => {
      const SELECTOR = [
        "a[href]",
        "button",
        "input:not([type=hidden])",
        "textarea",
        "select",
        "[role=button]",
        "[role=link]",
        "[role=tab]",
        "[role=checkbox]",
        "[role=menuitem]",
        "[contenteditable=true]",
        "[onclick]",
      ].join(",");

      const isVisible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const style = window.getComputedStyle(el as HTMLElement);
        return style.visibility !== "hidden" && style.display !== "none";
      };

      const accName = (el: Element): string => {
        const he = el as HTMLElement;
        const aria = he.getAttribute("aria-label");
        if (aria) return aria.trim();
        const title = he.getAttribute("title");
        const ph = he.getAttribute("placeholder");
        const val = (he as HTMLInputElement).value;
        const text = (he.innerText || he.textContent || "").trim().replace(/\s+/g, " ");
        return (text || title || ph || val || "").slice(0, 120);
      };

      const nodes: {
        ref: number;
        role: string;
        name: string;
        tag: string;
        value?: string;
      }[] = [];
      let ref = 0;
      document.querySelectorAll(SELECTOR).forEach((el) => {
        if (!isVisible(el)) return;
        el.setAttribute(refAttr, String(ref));
        const he = el as HTMLElement;
        const role =
          he.getAttribute("role") ||
          (he.tagName === "A"
            ? "link"
            : he.tagName === "INPUT"
              ? `input:${(he as HTMLInputElement).type || "text"}`
              : he.tagName.toLowerCase());
        nodes.push({
          ref,
          role,
          name: accName(el),
          tag: he.tagName.toLowerCase(),
          value: (he as HTMLInputElement).value || undefined,
        });
        ref++;
      });
      return nodes;
    }, REF_ATTR);
  }

  /**
   * Download a file straight from a URL, bypassing page rendering. Works for
   * any content-type (unlike an <a download> click, which the browser ignores
   * for inline types like text/plain or cross-origin links). Reuses the
   * browser context so cookies/auth from the current session apply.
   */
  async downloadUrl(url: string): Promise<DownloadRecord> {
    await this.ensure();
    const resp = await this.context!.request.get(url);
    if (!resp.ok()) {
      throw new Error(`Download failed: HTTP ${resp.status()} for ${url}`);
    }
    const body = await resp.body();

    // Filename: Content-Disposition, else the URL path, else a fallback.
    let name = "";
    const cd = resp.headers()["content-disposition"] || "";
    const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    if (m) name = decodeURIComponent(m[1].replace(/"/g, ""));
    if (!name) {
      try {
        name = path.basename(new URL(url).pathname) || "";
      } catch {
        name = "";
      }
    }
    if (!name) name = "download";

    const dest = path.join(this.downloadDir, this.uniqueName(name));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(dest, body);
    const rec: DownloadRecord = {
      filename: path.basename(dest),
      path: dest,
      url,
      startedAt: new Date().toISOString(),
    };
    this.downloads.push(rec);
    return rec;
  }

  /** Resolve a target from either a ref (preferred) or visible text. */
  locator(page: Page, opts: { ref?: number; text?: string }) {
    if (opts.ref !== undefined) {
      return page.locator(`[${REF_ATTR}="${opts.ref}"]`);
    }
    if (opts.text) {
      // Prefer an actionable role match, fall back to any element with the text.
      return page
        .getByRole("button", { name: opts.text })
        .or(page.getByRole("link", { name: opts.text }))
        .or(page.getByText(opts.text, { exact: false }))
        .first();
    }
    throw new Error("Provide either `ref` (from browser_snapshot) or `text`.");
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.pages = [];
    this.activeIndex = 0;
  }
}

export const manager = new BrowserManager();
