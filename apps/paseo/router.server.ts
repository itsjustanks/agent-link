import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { cookieHeader, last4 } from "./router.logic";

const HOME = homedir();

/**
 * agent-link's home. Kept from the pre-9router layout so an existing install
 * keeps its settings file; `accounts/` under here is the user's real sign-in
 * data and is never read or written by this plugin.
 */
export const ROOT = (() => {
  const explicit = process.env.AGENT_LINK_HOME ?? process.env.AGENT_AUTH_HOME;
  if (explicit) return explicit;
  const link = join(HOME, ".agent-link");
  const auth = join(HOME, ".agent-auth");
  if (existsSync(auth) && !existsSync(link)) return auth;
  return link;
})();

export const SETTINGS_PATH = join(ROOT, "9router.json");

export type RouterSettings = { url: string; apiKey: string | null; password: string | null };

const DEFAULT_URL = "http://127.0.0.1:20128";

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readSettings(): RouterSettings {
  const saved = readJsonFile(SETTINGS_PATH) ?? {};
  const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
  return {
    url: (process.env.AGENT_LINK_9ROUTER_URL ?? str(saved.url) ?? DEFAULT_URL).replace(/\/+$/, ""),
    apiKey: process.env.AGENT_LINK_9ROUTER_KEY ?? str(saved.apiKey),
    password: str(saved.password),
  };
}

/**
 * The settings file holds a bearer key, so it is created private and an
 * existing file's permissions are never widened. A file that exists but cannot
 * be parsed is left alone rather than overwritten — a half-written config is
 * recoverable, a clobbered one is not.
 */
export function writeSettings(next: Partial<RouterSettings>): RouterSettings {
  if (existsSync(SETTINGS_PATH) && readJsonFile(SETTINGS_PATH) === null) {
    throw new Error(`${SETTINGS_PATH} exists but is not readable JSON — fix or remove it first.`);
  }
  const merged = { ...readSettings(), ...next };
  const mode = existsSync(SETTINGS_PATH) ? statSync(SETTINGS_PATH).mode & 0o777 : 0o600;
  const tmp = `${SETTINGS_PATH}.tmp-agent-link`;
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode });
  renameSync(tmp, SETTINGS_PATH);
  return merged;
}

export function findBinary(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 5_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A thin client for one 9router instance. The management API is cookie-based,
 * so the cookie is cached and re-minted on the first 401 rather than on every
 * call. Nothing here logs a key, a password or a cookie.
 */
export class RouterClient {
  readonly url: string;
  private readonly password: string | null;
  private readonly apiKey: string | null;
  private cookie: string | null = null;
  private loginError: string | null = null;

  constructor(settings: RouterSettings = readSettings()) {
    this.url = settings.url;
    this.password = settings.password;
    this.apiKey = settings.apiKey;
  }

  get hasPassword(): boolean {
    return this.password !== null;
  }

  get keyLast4(): string | null {
    return last4(this.apiKey);
  }

  get authError(): string | null {
    return this.loginError;
  }

  async health(): Promise<boolean> {
    try {
      const response = await request(`${this.url}/api/health`, { timeoutMs: 2_000 });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async login(): Promise<boolean> {
    if (!this.password) {
      this.loginError = "No dashboard password saved.";
      return false;
    }
    try {
      const response = await request(`${this.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: this.password }),
      });
      if (!response.ok) {
        this.loginError = response.status === 401 ? "Dashboard password rejected." : `Login failed (HTTP ${response.status}).`;
        return false;
      }
      // Node exposes repeated Set-Cookie via getSetCookie(); fall back to the
      // folded header on runtimes that lack it.
      const raw = typeof (response.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (response.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [response.headers.get("set-cookie") ?? ""];
      const cookie = cookieHeader(raw.filter(Boolean));
      if (!cookie) {
        this.loginError = "Login succeeded but returned no session cookie.";
        return false;
      }
      this.cookie = cookie;
      this.loginError = null;
      return true;
    } catch (error) {
      this.loginError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** Authenticated management call. Returns null when 9router is down or refuses the session. */
  async api<T>(path: string, init: RequestInit = {}): Promise<T | null> {
    const send = async (): Promise<Response | null> => {
      try {
        return await request(`${this.url}/api/${path.replace(/^\/+/, "")}`, {
          ...init,
          headers: { ...(init.headers ?? {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
          timeoutMs: 8_000,
        });
      } catch (error) {
        this.loginError = error instanceof Error ? error.message : String(error);
        return null;
      }
    };
    if (!this.cookie && !(await this.login())) return null;
    let response = await send();
    if (response?.status === 401) {
      this.cookie = null;
      if (!(await this.login())) return null;
      response = await send();
    }
    if (!response || !response.ok) {
      if (response) this.loginError = `HTTP ${response.status} on ${path}`;
      return null;
    }
    try {
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  async apiJson<T>(path: string, method: string, body: unknown): Promise<T | null> {
    return this.api<T>(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** `/v1/models` is public while REQUIRE_API_KEY is off; send the key when we have one. */
  async models(): Promise<string[]> {
    try {
      const response = await request(`${this.url}/v1/models`, {
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
        timeoutMs: 8_000,
      });
      if (!response.ok) return [];
      const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
      return (body.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string");
    } catch {
      return [];
    }
  }

  /** Mint an API key when the instance has none, so wiring never lands without one. */
  async ensureApiKey(): Promise<string | null> {
    const existing = await this.api<{ keys?: Array<{ key?: unknown; isActive?: unknown }> }>("keys");
    const active = (existing?.keys ?? []).find((entry) => entry.isActive !== false && typeof entry.key === "string");
    if (active && typeof active.key === "string") return active.key;
    const created = await this.apiJson<{ key?: { key?: unknown }; keys?: Array<{ key?: unknown }> }>(
      "keys",
      "POST",
      { name: "AgentLink" },
    );
    const minted = created?.key?.key ?? created?.keys?.[0]?.key;
    return typeof minted === "string" ? minted : null;
  }
}

/**
 * Start 9router detached so it outlives this handler, then wait for health.
 * stdio is ignored: a plugin handler is not a place to hold a server's pipes.
 */
export async function startRouter(url: string): Promise<{ ok: boolean; message: string }> {
  const binary = findBinary("9router");
  if (!binary) return { ok: false, message: "9router is not installed. Run: npm i -g 9router" };
  let host = "127.0.0.1";
  let port = "20128";
  try {
    const parsed = new URL(url);
    host = parsed.hostname || host;
    port = parsed.port || port;
  } catch {
    // keep the defaults
  }
  const child = spawn(binary, ["--no-browser", "--skip-update", "--host", host, "--port", port], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const client = new RouterClient({ url, apiKey: null, password: null });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await client.health()) return { ok: true, message: `9router is running at ${url}` };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, message: "9router did not become healthy within 20s. Run `9router` in a terminal to see why." };
}

/** Files the pre-9router agent-link installed into ROOT/bin, listed so wiring can remove them. */
export function listStaleShims(isStale: (name: string) => boolean): string[] {
  try {
    return readdirSync(join(ROOT, "bin")).filter(isStale);
  } catch {
    return [];
  }
}

export function removeShim(name: string): void {
  try {
    const path = join(ROOT, "bin", name);
    if (existsSync(path)) renameSync(path, `${path}.removed-by-agent-link`);
  } catch {
    // Best effort: a shim that cannot be moved is not worth failing the wire.
  }
}
