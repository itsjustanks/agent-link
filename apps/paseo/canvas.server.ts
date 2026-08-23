import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, openSync, readSync, closeSync, readdirSync, realpathSync, statSync, type Dirent, type Stats } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, platform } from "node:os";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { Artifact, ArtifactKind, CanvasState, Render } from "./canvas.shared";
import { markdownToHtml, wrapDocument, wrapSvg, type PageTheme } from "./markdown.server";
import { chromeHint, closeBrowser, findChrome, renderUrl } from "./render.server";

const HOME = homedir();

// Folders an agent actually writes a dashboard into. Scanning a whole worktree
// would surface every fixture and coverage report in the repo.
const ARTIFACT_DIRS = ["artifacts", ".artifacts", "canvas", "canvases", "dashboard", "dashboards", "reports", "public/reports"];
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "target", "vendor", "coverage", ".venv", "__pycache__",
]);
// Personal folders outside any workspace — where a one-off report tends to land.
const PERSONAL_ROOTS = [join(HOME, "Artifacts"), join(HOME, "Diagrams"), join(HOME, "Canvas")];
// Claude Code writes an artifact into its per-session scratchpad before (or
// instead of) publishing it. Those pages are otherwise unreachable: the folder
// is a temp path nobody browses, and a published artifact lives behind a login.
const CLAUDE_SCRATCH = "/private/tmp";
const CLAUDE_SCRATCH_ROOTS = 8;

function claudeScratchpads(): Root[] {
  const found: Array<{ dir: string; at: number }> = [];
  for (const uid of listDirNames(CLAUDE_SCRATCH, /^claude-\d+$/)) {
    for (const project of listDirNames(join(CLAUDE_SCRATCH, uid), /^-/)) {
      for (const session of listDirNames(join(CLAUDE_SCRATCH, uid, project), /./)) {
        const dir = join(CLAUDE_SCRATCH, uid, project, session, "scratchpad");
        try {
          found.push({ dir, at: statSync(dir).mtimeMs });
        } catch {
          // no scratchpad in this session
        }
      }
    }
  }
  return found
    .sort((a, b) => b.at - a.at)
    .slice(0, CLAUDE_SCRATCH_ROOTS)
    .map((entry) => ({ dir: entry.dir, label: "Claude artifacts", personal: true }));
}

function listDirNames(root: string, match: RegExp): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && match.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
const MAX_PER_ROOT = 120;
const MAX_DEPTH = 2;

// What the panel can render, and how. Markdown matters as much as HTML: an
// agent asked for a report writes .md far more often than a styled page.
const KINDS: Record<string, ArtifactKind> = {
  ".html": "html",
  ".htm": "html",
  ".md": "markdown",
  ".markdown": "markdown",
  ".svg": "svg",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
};

function kindOf(name: string): ArtifactKind | null {
  return KINDS[extname(name).toLowerCase()] ?? null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

// ------------------------------------------------------------------ discovery

function titleOf(path: string, kind: ArtifactKind): string {
  if (kind === "image") return "";
  // Only the head of the file: a generated dashboard can be megabytes of data.
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, read).toString("utf8");
    if (kind === "markdown") {
      const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(head);
      return heading ? heading[1]!.replace(/[*_`#]/g, "").trim().slice(0, 120) : "";
    }
    const match = /<title[^>]*>([\s\S]{1,200}?)<\/title>/i.exec(head);
    return match ? match[1]!.replace(/\s+/g, " ").trim() : "";
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // closing a file we already read is not worth failing a scan over
      }
    }
  }
}

function display(dir: string): string {
  return dir === HOME ? "~" : dir.startsWith(HOME + sep) ? `~${dir.slice(HOME.length)}` : dir;
}

function collect(dir: string, where: string, depth: number, found: Artifact[], images = true): void {
  if (found.length >= MAX_PER_ROOT || depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (found.length >= MAX_PER_ROOT) return;
    if (entry.name.startsWith(".") && entry.name !== ".artifacts") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (depth < MAX_DEPTH) collect(full, where, depth + 1, found, images);
      continue;
    }
    if (!entry.isFile()) continue;
    const kind = kindOf(entry.name);
    if (!kind) continue;
    // Every repo root has a logo and a screenshot; those are not artifacts.
    if (kind === "image" && !images) continue;
    // A README in every repo root is noise, not an artifact someone made.
    if (kind === "markdown" && /^(readme|changelog|license|contributing|agents|claude)\b/i.test(entry.name)) continue;
    let stats: Stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    found.push({
      path: full,
      name: entry.name,
      title: stats.size < 2_000_000 ? titleOf(full, kind) : "",
      dir: display(dir),
      where,
      kind,
      bytes: stats.size,
      modified: Math.floor(stats.mtimeMs / 1000),
      localUrl: "",
      publicUrl: "",
    });
  }
}

type Root = { dir: string; label: string; personal: boolean };

async function workspaceRoots(paseo: PluginHandlerContext["paseo"]): Promise<{ roots: Root[]; error: string }> {
  const roots: Root[] = [];
  let error = "";
  try {
    const api = paseo as unknown as { workspaces: { list: (options?: unknown) => Promise<{ entries: unknown[] }> } };
    const result = await api.workspaces.list({ page: { limit: 200 } });
    for (const raw of result.entries ?? []) {
      const entry = raw as Record<string, unknown>;
      if (entry.archivingAt) continue;
      const dir =
        typeof entry.workspaceDirectory === "string" && entry.workspaceDirectory.length > 0
          ? entry.workspaceDirectory
          : typeof entry.projectRootPath === "string"
            ? entry.projectRootPath
            : "";
      if (!dir) continue;
      roots.push({ dir, label: String(entry.name ?? basename(dir)), personal: false });
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  for (const dir of PERSONAL_ROOTS) if (existsSync(dir)) roots.push({ dir, label: `~/${basename(dir)}`, personal: true });
  roots.push(...claudeScratchpads());
  // Two workspaces can point at one directory; scan it once.
  const seen = new Set<string>();
  return { roots: roots.filter((root) => (seen.has(root.dir) ? false : seen.add(root.dir))), error };
}

let cache: { at: number; artifacts: Artifact[]; roots: string[]; error: string } | null = null;

async function discover(paseo: PluginHandlerContext["paseo"], refresh: boolean): Promise<{ artifacts: Artifact[]; roots: string[]; error: string }> {
  if (!refresh && cache && Date.now() - cache.at < 10_000) return cache;
  const { roots, error } = await workspaceRoots(paseo);
  const artifacts: Artifact[] = [];
  for (const root of roots) {
    const found: Artifact[] = [];
    // Files sitting at the top of the folder, then the conventional artifact
    // folders in full. Starting at MAX_DEPTH takes the files and recurses no
    // further, which is what keeps a whole worktree out of the list.
    collect(root.dir, root.label, MAX_DEPTH, found, root.personal);
    for (const name of ARTIFACT_DIRS) {
      const dir = join(root.dir, name);
      if (existsSync(dir)) collect(dir, root.label, 1, found, true);
    }
    artifacts.push(...found);
  }
  const seen = new Set<string>();
  const unique = artifacts
    .filter((artifact) => (seen.has(artifact.path) ? false : seen.add(artifact.path)))
    .sort((a, b) => b.modified - a.modified)
    .slice(0, 200);
  cache = { at: Date.now(), artifacts: unique, roots: roots.map((root) => root.dir), error };
  return cache;
}

// -------------------------------------------------------------- local serving

type Share = { token: string; root: string; entry: string; kind: ArtifactKind; theme?: PageTheme };

const shares = new Map<string, Share>(); // key: absolute artifact path
let server: Server | null = null;
let serverPort = 0;

function send(response: import("node:http").ServerResponse, code: number, body: string): void {
  response.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

async function serveRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "s" || !parts[1]) return send(response, 404, "Not found.");
  const share = [...shares.values()].find((candidate) => candidate.token === parts[1]);
  if (!share) return send(response, 404, "This link is no longer shared.");
  const rest = parts.slice(2).map(decodeURIComponent).join("/");
  const target = rest ? resolve(share.root, rest) : share.entry;
  // The token names a directory; a request must not climb out of it.
  if (target !== share.root && !target.startsWith(share.root + sep)) return send(response, 403, "Forbidden.");

  // A markdown report or a bare SVG becomes a page at request time rather than
  // being frozen into one at share time — so the link keeps showing the file as
  // it is now, which is the whole difference from uploading a copy somewhere.
  if (target === share.entry && share.kind !== "html") {
    try {
      const html = await pageFor(share.entry, share.kind, share.theme, "./");
      const body = Buffer.from(html, "utf8");
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(body.byteLength),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      response.end(body);
    } catch {
      send(response, 404, "That file could not be read.");
    }
    return;
  }

  let stats: Stats;
  try {
    stats = statSync(target);
  } catch {
    return send(response, 404, "Not found.");
  }
  if (stats.isDirectory()) return send(response, 404, "Not found.");
  response.writeHead(200, {
    "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(stats.size),
    "cache-control": "no-store",
    // A shared canvas is a document, not a frame host for someone else.
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  createReadStream(target).pipe(response);
}

async function ensureServer(): Promise<number> {
  if (server && serverPort) return serverPort;
  const instance = createServer((request, response) => {
    void serveRequest(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, "That request failed.");
    });
  });

  const port = await new Promise<number>((resolveport, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => {
      const address = instance.address();
      resolveport(typeof address === "object" && address ? address.port : 0);
    });
  });
  server = instance;
  serverPort = port;
  return port;
}

// ------------------------------------------------------------------- tunnel

type Tunnel = { state: "off" | "starting" | "on" | "failed"; url: string; error: string; since: number };
let tunnel: Tunnel = { state: "off", url: "", error: "", since: 0 };
let tunnelProcess: ChildProcess | null = null;

function whichCloudflared(): string {
  const candidates = [
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
    join(HOME, ".local/bin/cloudflared"),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "cloudflared");
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function installHint(): string {
  if (platform() === "darwin") return "brew install cloudflared";
  if (platform() === "win32") return "winget install --id Cloudflare.cloudflared";
  return "sudo apt install cloudflared   # or: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * cloudflared prints the hostname before DNS carries it, and a lookup made in
 * that window is cached as NXDOMAIN — measured here: the address resolved at
 * 1.1.1.1 after 5s while the machine that asked at 0s stayed broken for the
 * length of the negative TTL. So the link is held back until it answers, and
 * the first check waits rather than being the request that poisons the cache.
 */
async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(6_000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Fire and forget: bringing a tunnel up takes tens of seconds, which is far too
 * long to hold an RPC open. The state moves starting → on|failed underneath and
 * the panel polls while it is starting.
 */
function startTunnel(): void {
  if (tunnel.state === "on" || tunnel.state === "starting") return;
  const binary = whichCloudflared();
  if (!binary) {
    tunnel = { state: "failed", url: "", error: `cloudflared is not installed — ${installHint()}`, since: 0 };
    return;
  }
  tunnel = { state: "starting", url: "", error: "", since: Math.floor(Date.now() / 1000) };

  void (async () => {
    const port = await ensureServer();
    const child = spawn(binary, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    tunnelProcess = child;

    const url = await new Promise<string>((done) => {
      let buffer = "";
      const timer = setTimeout(() => done(""), 40_000);
      const onChunk = (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(buffer);
        if (!match) return;
        clearTimeout(timer);
        done(match[0]);
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.once("exit", () => {
        clearTimeout(timer);
        done("");
      });
    });

    if (!url) {
      child.kill("SIGTERM");
      if (tunnelProcess === child) tunnelProcess = null;
      tunnel = { state: "failed", url: "", error: "cloudflared did not return a link. Run it once by hand to see why.", since: 0 };
      return;
    }

    child.once("exit", () => {
      if (tunnelProcess === child) {
        tunnelProcess = null;
        tunnel = { state: "off", url: "", error: "The tunnel closed.", since: 0 };
      }
    });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await sleep(attempt === 0 ? 6_000 : 4_000);
      if (tunnelProcess !== child) return; // stopped while we waited
      if (await reachable(url)) {
        tunnel = { state: "on", url, error: "", since: Math.floor(Date.now() / 1000) };
        return;
      }
    }
    tunnel = {
      state: "on",
      url,
      error: "The tunnel is up but the address is not resolving here yet. Give it a minute before sharing the link.",
      since: Math.floor(Date.now() / 1000),
    };
  })();
}

function stopTunnel(): void {
  tunnelProcess?.kill("SIGTERM");
  tunnelProcess = null;
  tunnel = { state: "off", url: "", error: "", since: 0 };
}

// -------------------------------------------------------------------- state

function decorate(artifacts: Artifact[]): Artifact[] {
  return artifacts.map((artifact) => {
    const share = shares.get(artifact.path);
    if (!share) return artifact;
    return {
      ...artifact,
      localUrl: serverPort ? `http://127.0.0.1:${serverPort}/s/${share.token}/` : "",
      publicUrl: tunnel.state === "on" ? `${tunnel.url}/s/${share.token}/` : "",
    };
  });
}

async function state(paseo: PluginHandlerContext["paseo"], refresh: boolean): Promise<CanvasState> {
  const found = await discover(paseo, refresh);
  const binary = whichCloudflared();
  const chrome = findChrome();
  return {
    artifacts: decorate(found.artifacts),
    roots: found.roots,
    serving: [...shares.keys()],
    serverUrl: serverPort ? `http://127.0.0.1:${serverPort}` : "",
    tunnel,
    renderer: {
      installed: Boolean(chrome),
      path: chrome,
      install: chromeHint(),
      note: chrome
        ? "Artifacts are rendered on the daemon and shown here as an image."
        : "Chrome or Chromium renders artifacts for the panel. Without it you can still share a link.",
    },
    cloudflared: {
      installed: Boolean(binary),
      path: binary,
      install: installHint(),
      note: binary
        ? "Sharing creates a Cloudflare quick tunnel. The link is public while it is up, and dies when Paseo stops."
        : "Local preview works without it. A public link needs cloudflared.",
    },
    error: found.error,
  };
}

export async function handleCanvasState(
  { refresh }: { refresh?: boolean },
  { paseo }: PluginHandlerContext,
): Promise<CanvasState> {
  return state(paseo, Boolean(refresh));
}

export async function handleCanvasServe(
  { path, share, theme }: { path: string; share: boolean; theme?: PageTheme },
  { paseo }: PluginHandlerContext,
): Promise<CanvasState> {
  // The path comes from our own scan, but it reaches the filesystem and then a
  // public URL, so re-prove it before serving anything from its folder.
  const target = realpathSync(path);
  if (!statSync(target).isFile()) throw new Error("That is not a file.");
  const kind = kindOf(target);
  if (!kind) throw new Error("That file type cannot be shared.");

  if (!shares.has(target)) {
    shares.set(target, {
      token: randomBytes(12).toString("hex"),
      root: realpathSync(join(target, "..")),
      entry: target,
      kind,
      theme,
    });
  }
  await ensureServer();
  if (share) startTunnel();
  return state(paseo, false);
}

export async function handleCanvasStop(
  { path }: { path?: string },
  { paseo }: PluginHandlerContext,
): Promise<CanvasState> {
  if (path) shares.delete(realpathSync(path));
  else shares.clear();
  if (shares.size === 0) stopTunnel();
  return state(paseo, false);
}

/** Only our own links: a local preview, or the quick tunnel we started. */
function assertOurs(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Not a URL.");
  }
  const local = parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  const shared = parsed.protocol === "https:" && parsed.hostname.endsWith(".trycloudflare.com");
  if (!local && !shared) throw new Error(`Refusing to open ${parsed.hostname}.`);
  return parsed;
}

export function handleCanvasOpen({ url }: { url: string }): { opened: boolean; message: string } {
  const allowed = assertOurs(url);
  const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  try {
    spawn(opener, [allowed.href], { stdio: "ignore", detached: true, shell: platform() === "win32" }).unref();
    return { opened: true, message: "Opened in the browser on the daemon machine." };
  } catch (caught) {
    return { opened: false, message: caught instanceof Error ? caught.message : String(caught) };
  }
}

/**
 * React Native dropped Clipboard from core and this panel runs on phones too,
 * so the copy happens on the daemon and the link is also selectable text.
 */
export function handleCanvasCopy({ url }: { url: string }): { copied: boolean } {
  const allowed = assertOurs(url);
  const [command, args] =
    platform() === "darwin"
      ? ["pbcopy", [] as string[]]
      : platform() === "win32"
        ? ["clip", []]
        : ["xclip", ["-selection", "clipboard"]];
  try {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin?.end(allowed.href);
    return { copied: true };
  } catch {
    return { copied: false };
  }
}


// -------------------------------------------------------------------- render

/**
 * Rendered pages, keyed by file + mtime + size + theme. An artifact is a file
 * on disk, so its mtime is a perfect cache key: edit it and the next render is
 * a miss, leave it alone and reopening is instant.
 */
const renders = new Map<string, Render>();
let renderBytes = 0;
const RENDER_CACHE_BYTES = 48 * 1024 * 1024;

function remember(key: string, render: Render): void {
  renders.set(key, render);
  renderBytes += render.bytes;
  while (renderBytes > RENDER_CACHE_BYTES && renders.size > 1) {
    const oldest = renders.keys().next().value as string | undefined;
    if (!oldest) break;
    renderBytes -= renders.get(oldest)?.bytes ?? 0;
    renders.delete(oldest);
  }
}

function themeKey(theme?: PageTheme): string {
  return theme ? `${theme.background}${theme.foreground}${theme.muted}${theme.accent}` : "-";
}

/** Markdown, SVG and images become a small page so one renderer serves all. */
async function pageFor(file: string, kind: ArtifactKind, theme?: PageTheme, base?: string): Promise<string> {
  const baseHref = base ?? `file://${join(file, "..")}/`;
  const title = basename(file);
  if (kind === "markdown") {
    const text = await readFile(file, "utf8");
    return wrapDocument(markdownToHtml(text), { title, baseHref, theme });
  }
  if (kind === "svg") {
    return wrapSvg(await readFile(file, "utf8"), { title, baseHref, theme });
  }
  const source = encodeURIComponent(basename(file));
  return wrapDocument(
    `<div style="display:flex;justify-content:center"><img src="${source}" alt="${title}"></div>`,
    { title, baseHref, theme, wide: true },
  );
}

async function renderAt(
  file: string,
  kind: ArtifactKind,
  width: number,
  scale: number,
  theme?: PageTheme,
): Promise<Awaited<ReturnType<typeof renderUrl>>> {
  if (kind === "html") return renderUrl(`file://${file}`, { width, scale });
  const work = await mkdtemp(join(tmpdir(), "agent-link-page-"));
  const page = join(work, "page.html");
  try {
    await writeFile(page, await pageFor(file, kind, theme), "utf8");
    return await renderUrl(`file://${page}`, { width, scale });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function handleCanvasRender(
  { path, width, scale, theme }: { path: string; width: number; scale: number; theme?: PageTheme },
): Promise<Render> {
  const file = realpathSync(path);
  const stats = statSync(file);
  if (!stats.isFile()) throw new Error("That is not a file.");
  const kind = kindOf(file);
  if (!kind) throw new Error("That file type cannot be shown here.");
  if (!findChrome()) throw new Error(`Rendering needs Chrome or Chromium — ${chromeHint()}`);

  // An HTML artifact brings its own styling, so the app theme is not part of
  // its identity; a generated page is drawn in the theme and so it is.
  const key = `${file}:${stats.mtimeMs}:${width}:${scale}:${kind === "html" ? "-" : themeKey(theme)}`;
  const hit = renders.get(key);
  if (hit) return { ...hit, fromCache: true, ms: 0 };

  const started = Date.now();
  let shot = await renderAt(file, kind, width, scale, theme);

  // A very long page at 2x turns into a payload nobody wants to push over a
  // remote connection. Halve it rather than refuse it.
  if (shot.bytes > 3_000_000 && scale > 1) {
    const lighter = await renderAt(file, kind, width, 1, theme);
    if (lighter.bytes < shot.bytes) shot = lighter;
  }

  const render: Render = {
    dataUri: `data:image/${shot.format};base64,${shot.base64}`,
    width: shot.width,
    height: shot.height,
    bytes: shot.bytes,
    truncated: shot.truncated,
    title: shot.title || basename(file),
    fromCache: false,
    ms: Date.now() - started,
  };
  remember(key, render);
  return render;
}

const MAX_SOURCE_BYTES = 400_000;

/** The file as text, for reading a report rather than looking at a picture. */
export async function handleCanvasSource({ path }: { path: string }): Promise<{ text: string; truncated: boolean; bytes: number }> {
  const file = realpathSync(path);
  const stats = statSync(file);
  const kind = kindOf(file);
  if (!kind || kind === "image") throw new Error("That artifact has no text to show.");
  const text = await readFile(file, "utf8");
  return {
    text: text.slice(0, MAX_SOURCE_BYTES),
    truncated: text.length > MAX_SOURCE_BYTES,
    bytes: stats.size,
  };
}

/** Nothing outlives the plugin: close the server, tunnel and browser. */
export function canvasShutdown(): void {
  stopTunnel();
  shares.clear();
  renders.clear();
  renderBytes = 0;
  server?.close();
  server = null;
  serverPort = 0;
  void closeBrowser();
}
