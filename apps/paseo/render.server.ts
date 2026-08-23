import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

/**
 * Turning an artifact into pixels, on the daemon.
 *
 * A Paseo surface is React Native: no WebView, no iframe, so HTML cannot be
 * displayed by the panel itself. Rasterising here is also the only thing that
 * works when the daemon is a server somewhere else — opening a browser on that
 * machine shows the page to nobody.
 *
 * Chrome is driven over the DevTools protocol rather than `--screenshot`,
 * because the flag captures the window and an agent's dashboard is usually
 * taller than any window. CDP reports the real content height and captures
 * beyond the viewport. Node's built-in WebSocket makes that dependency-free.
 */

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const LAUNCH_TIMEOUT_MS = 20_000;
const RENDER_TIMEOUT_MS = 45_000;
const IDLE_SHUTDOWN_MS = 120_000;
/** Layout viewport height; a page taller than this is captured beyond it. */
const VIEWPORT = 900;
/** Beyond this the PNG stops being worth sending over an RPC. */
export const MAX_HEIGHT = 12_000;
export const MAX_PNG_BYTES = 12 * 1024 * 1024;

/**
 * Playwright and Puppeteer both cache a `chrome-headless-shell` — the same
 * engine without the browser around it. It starts several times faster than
 * full Chrome, so it is preferred when one is already on the machine. Newest
 * build first; nothing is ever downloaded.
 */
function headlessShells(): string[] {
  const homes = [
    join(HOME, "Library/Caches/ms-playwright"),
    join(HOME, ".cache/ms-playwright"),
    join(HOME, ".cache/puppeteer/chrome-headless-shell"),
    join(HOME, "AppData/Local/ms-playwright"),
  ];
  const found: Array<{ path: string; build: number }> = [];
  for (const root of homes) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/headless[-_]shell|^mac_|^linux|^win/i.test(entry)) continue;
      const build = Number(/(\d+)/.exec(entry)?.[1] ?? 0);
      for (const platformDir of ["chrome-headless-shell-mac-arm64", "chrome-headless-shell-mac-x64", "chrome-headless-shell-linux64", "chrome-headless-shell-win64"]) {
        const candidate = join(root, entry, platformDir, process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
        try {
          accessSync(candidate, constants.X_OK);
          found.push({ path: candidate, build });
        } catch {
          // not this layout
        }
      }
    }
  }
  return found.sort((a, b) => b.build - a.build).map((entry) => entry.path);
}

export function findChrome(): string {
  // An explicit override always wins over anything discovered.
  for (const candidate of [process.env.CHROME_BIN, process.env.CHROME_PATH]) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // fall through to discovery
    }
  }
  const shell = headlessShells()[0];
  if (shell) return shell;
  for (const candidate of CHROME_CANDIDATES) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return "";
}

export function chromeHint(): string {
  if (process.platform === "darwin") return "brew install --cask google-chrome";
  if (process.platform === "win32") return "winget install --id Google.Chrome";
  return "sudo apt install chromium   # or set CHROME_BIN for the Paseo daemon";
}

// ------------------------------------------------------------- browser process

type Browser = { process: ChildProcess; wsUrl: string; profile: string };

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  // Chrome is ~1s to start, so it is kept warm between renders, but a browser
  // sitting on a user's machine forever is rude.
  idleTimer = setTimeout(() => void closeBrowser(), IDLE_SHUTDOWN_MS);
  idleTimer.unref?.();
}

async function launch(): Promise<Browser> {
  const binary = findChrome();
  if (!binary) throw new Error(`No Chrome or Chromium on this machine — ${chromeHint()}`);
  const profile = await mkdtemp(join(tmpdir(), "agent-link-canvas-"));
  const isShell = /headless[-_]shell/i.test(binary);
  const child = spawn(
    binary,
    [
      ...(isShell ? [] : ["--headless=new"]),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const wsUrl = await new Promise<string>((done, fail) => {
    let buffer = "";
    const timer = setTimeout(() => fail(new Error("Chrome did not start in time.")), LAUNCH_TIMEOUT_MS);
    const onChunk = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[a-f0-9-]+/i.exec(buffer);
      if (!match) return;
      clearTimeout(timer);
      done(match[0]);
    };
    child.stderr?.on("data", onChunk);
    child.stdout?.on("data", onChunk);
    child.once("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`Chrome exited before it was ready (code ${code}).`));
    });
  }).catch(async (error) => {
    child.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true });
    throw error;
  });

  const instance: Browser = { process: child, wsUrl, profile };
  child.once("exit", () => {
    if (browser === instance) browser = null;
    void rm(profile, { recursive: true, force: true });
  });
  return instance;
}

async function ensureBrowser(): Promise<Browser> {
  if (browser && !browser.process.killed) return browser;
  if (!launching) {
    launching = launch()
      .then((instance) => {
        browser = instance;
        return instance;
      })
      .finally(() => {
        launching = null;
      });
  }
  return launching;
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const instance = browser;
  browser = null;
  if (!instance) return;
  instance.process.kill("SIGTERM");
  setTimeout(() => instance.process.kill("SIGKILL"), 2_000).unref?.();
  await rm(instance.profile, { recursive: true, force: true }).catch(() => {});
}

// ------------------------------------------------------------------- CDP client

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };

/** A minimal DevTools client: send a command, await its reply, watch events. */
class Session {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();
  private closed: Error | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => this.receive(String((event as MessageEvent).data)));
    socket.addEventListener("close", () => this.fail(new Error("Chrome closed the connection.")));
    socket.addEventListener("error", () => this.fail(new Error("The Chrome connection failed.")));
  }

  static async open(url: string): Promise<Session> {
    const socket = new WebSocket(url);
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("Timed out connecting to Chrome.")), 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        done();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        fail(new Error("Could not connect to Chrome."));
      });
    });
    return new Session(socket);
  }

  private receive(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id as number | undefined;
    if (typeof id === "number") {
      const waiting = this.pending.get(id);
      if (!waiting) return;
      this.pending.delete(id);
      const error = message.error as { message?: string } | undefined;
      if (error) waiting.reject(new Error(error.message ?? "Chrome rejected the command."));
      else waiting.resolve((message.result ?? {}) as Record<string, unknown>);
      return;
    }
    const method = message.method as string | undefined;
    if (!method) return;
    for (const listener of this.listeners.get(method) ?? []) {
      listener((message.params ?? {}) as Record<string, unknown>);
    }
  }

  private fail(error: Error): void {
    this.closed = error;
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): void {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`Chrome did not answer ${method}.`));
      }, RENDER_TIMEOUT_MS).unref?.();
    });
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------- render

export type Shot = {
  base64: string;
  format: "webp" | "png";
  width: number;
  height: number;
  bytes: number;
  truncated: boolean; // the page was taller than the cap
  title: string;
};

export type RenderOptions = {
  /** CSS pixels of page width to lay out at. */
  width: number;
  /** 1 for a light payload, 2 for a retina-sharp one. */
  scale: number;
  /** Cap the captured height; the rest is cut off rather than refused. */
  maxHeight?: number;
  /** WebP is ~3x smaller than PNG, which matters over a remote connection. */
  format?: "webp" | "png";
};

/**
 * Load a URL (normally file://) and capture the whole page.
 * Runs in a fresh tab each time so one bad artifact cannot poison the next.
 */
export async function renderUrl(url: string, options: RenderOptions): Promise<Shot> {
  const instance = await ensureBrowser();
  touchIdle();
  const session = await Session.open(instance.wsUrl);
  let targetId = "";
  try {
    const created = await session.send("Target.createTarget", { url: "about:blank" });
    targetId = String(created.targetId ?? "");
    const attached = await session.send("Target.attachToTarget", { targetId, flatten: true });
    const sid = String(attached.sessionId ?? "");

    await session.send("Page.enable", {}, sid);
    await session.send(
      "Emulation.setDeviceMetricsOverride",
      { width: options.width, height: VIEWPORT, deviceScaleFactor: options.scale, mobile: false },
      sid,
    );

    const loaded = new Promise<void>((done) => {
      const timer = setTimeout(done, 15_000); // a page that never fires load still gets captured
      timer.unref?.();
      session.on("Page.loadEventFired", () => {
        clearTimeout(timer);
        done();
      });
    });
    await session.send("Page.navigate", { url }, sid);
    await loaded;
    // Fonts, images and any late layout settle in the next couple of frames.
    await new Promise((done) => setTimeout(done, 350));

    const metrics = (await session.send("Page.getLayoutMetrics", {}, sid)) as {
      cssContentSize?: { width?: number; height?: number };
      contentSize?: { width?: number; height?: number };
    };
    const content = metrics.cssContentSize ?? metrics.contentSize ?? {};
    const cap = options.maxHeight ?? MAX_HEIGHT;
    const scrolled = Math.ceil(Number(content.height ?? VIEWPORT));
    // A page shorter than the viewport still reports the viewport height, which
    // captures a slab of empty background under the content. Ask the document
    // how tall it actually is, and only trust the metric when it scrolls.
    const measured = Number(
      ((await session.send(
        "Runtime.evaluate",
        {
          expression:
            "Math.ceil(document.body.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(document.body).marginBottom) || 0))",
          returnByValue: true,
        },
        sid,
      )) as { result?: { value?: unknown } }).result?.value ?? 0,
    );
    const fullHeight = Math.max(
      1,
      scrolled > VIEWPORT ? scrolled : measured > 0 ? Math.min(measured, VIEWPORT) : scrolled,
    );
    const height = Math.min(fullHeight, cap);
    const width = Math.max(options.width, Math.ceil(Number(content.width ?? options.width)));

    const title = String(
      ((await session.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sid)) as {
        result?: { value?: unknown };
      }).result?.value ?? "",
    );

    const capture = async (format: "webp" | "png") =>
      (await session.send(
        "Page.captureScreenshot",
        {
          format,
          ...(format === "webp" ? { quality: 88 } : {}),
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: options.scale },
        },
        sid,
      )) as { data?: string };

    let format: "webp" | "png" = options.format ?? "webp";
    let shot = await capture(format).catch(async (error: Error) => {
      // An older build that will not encode WebP still owes us a picture.
      if (format === "png") throw error;
      format = "png";
      return capture("png");
    });
    let base64 = String(shot.data ?? "");
    if (!base64 && format === "webp") {
      format = "png";
      shot = await capture("png");
      base64 = String(shot.data ?? "");
    }
    if (!base64) throw new Error("Chrome returned an empty image.");
    const bytes = Math.floor((base64.length * 3) / 4);
    if (bytes > MAX_PNG_BYTES) {
      throw new Error(`That render is ${(bytes / 1_048_576).toFixed(1)} MB — try 1× instead of 2×.`);
    }
    return {
      base64,
      format,
      width: Math.round(width * options.scale),
      height: Math.round(height * options.scale),
      bytes,
      truncated: fullHeight > height,
      title,
    };
  } finally {
    if (targetId) await session.send("Target.closeTarget", { targetId }).catch(() => {});
    session.close();
  }
}
