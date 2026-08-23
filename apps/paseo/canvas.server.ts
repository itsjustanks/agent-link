import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, openSync, readSync, closeSync, readdirSync, realpathSync, statSync, type Dirent, type Stats } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, platform } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import type { Artifact, CanvasState } from "./canvas.shared";

const HOME = homedir();

// Folders an agent actually writes a dashboard into. Scanning a whole worktree
// would surface every fixture and coverage report in the repo.
const ARTIFACT_DIRS = ["artifacts", ".artifacts", "canvas", "canvases", "dashboard", "dashboards", "reports", "public/reports"];
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "target", "vendor", "coverage", ".venv", "__pycache__",
]);
// Personal folders outside any workspace — where a one-off report tends to land.
const PERSONAL_ROOTS = [join(HOME, "Artifacts"), join(HOME, "Diagrams"), join(HOME, "Canvas")];
const MAX_PER_ROOT = 120;
const MAX_DEPTH = 2;

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

function titleOf(path: string): string {
  // Only the head of the file: a generated dashboard can be megabytes of data.
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(4096);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const match = /<title[^>]*>([\s\S]{1,200}?)<\/title>/i.exec(buffer.subarray(0, read).toString("utf8"));
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

function collect(dir: string, where: string, depth: number, found: Artifact[]): void {
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
      if (depth < MAX_DEPTH) collect(full, where, depth + 1, found);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.html?$/i.test(entry.name)) continue;
    let stats: Stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    found.push({
      path: full,
      name: entry.name,
      title: stats.size < 2_000_000 ? titleOf(full) : "",
      dir: display(dir),
      where,
      bytes: stats.size,
      modified: Math.floor(stats.mtimeMs / 1000),
      localUrl: "",
      publicUrl: "",
    });
  }
}

type Root = { dir: string; label: string };

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
      roots.push({ dir, label: String(entry.name ?? basename(dir)) });
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  for (const dir of PERSONAL_ROOTS) if (existsSync(dir)) roots.push({ dir, label: `~/${basename(dir)}` });
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
    collect(root.dir, root.label, MAX_DEPTH, found);
    for (const name of ARTIFACT_DIRS) {
      const dir = join(root.dir, name);
      if (existsSync(dir)) collect(dir, root.label, 1, found);
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

type Share = { token: string; root: string; entry: string };

const shares = new Map<string, Share>(); // key: absolute artifact path
let server: Server | null = null;
let serverPort = 0;

function send(response: import("node:http").ServerResponse, code: number, body: string): void {
  response.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  response.end(body);
}

async function ensureServer(): Promise<number> {
  if (server && serverPort) return serverPort;
  const instance = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "s" || !parts[1]) return send(response, 404, "Not found.");
    const share = [...shares.values()].find((candidate) => candidate.token === parts[1]);
    if (!share) return send(response, 404, "This link is no longer shared.");
    const rest = parts.slice(2).map(decodeURIComponent).join("/");
    const target = rest ? resolve(share.root, rest) : share.entry;
    // The token names a directory; a request must not climb out of it.
    if (target !== share.root && !target.startsWith(share.root + sep)) return send(response, 403, "Forbidden.");
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
  return {
    artifacts: decorate(found.artifacts),
    roots: found.roots,
    serving: [...shares.keys()],
    serverUrl: serverPort ? `http://127.0.0.1:${serverPort}` : "",
    tunnel,
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
  { path, share }: { path: string; share: boolean },
  { paseo }: PluginHandlerContext,
): Promise<CanvasState> {
  // The path comes from our own scan, but it reaches the filesystem and then a
  // public URL, so re-prove it before serving anything from its folder.
  const target = realpathSync(path);
  if (!statSync(target).isFile()) throw new Error("That is not a file.");
  if (!/\.html?$/i.test(target)) throw new Error("Only HTML artifacts can be served.");

  if (!shares.has(target)) {
    shares.set(target, { token: randomBytes(12).toString("hex"), root: realpathSync(join(target, "..")), entry: target });
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

/** Nothing outlives the plugin: close the server and kill the tunnel. */
export function canvasShutdown(): void {
  stopTunnel();
  shares.clear();
  server?.close();
  server = null;
  serverPort = 0;
}
