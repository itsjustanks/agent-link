import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { deviceCode, stripTerminal, trustedAuthUrl } from "./auth.logic";
import { normalizeAccountEmail } from "./account-capacity.logic";
import type { AccountLoginSession, AccountSource } from "./auth.shared";
import {
  accountConfigDir,
  AGENT_LINK_HOME_DIR,
  claudeAccountEmail,
  codexAccountEmail,
  ensureManagedAccountSlot,
  searchPath,
} from "./handlers.server";
import { onShutdown } from "./lifecycle.shared";

type Provider = "claude" | "codex";
type ActiveStatus = "starting" | "awaiting_code" | "waiting";
type InternalSession = AccountLoginSession & {
  accountKey: string;
  configDir: string;
  child: ChildProcessWithoutNullStreams;
  output: string;
  timeout: ReturnType<typeof setTimeout>;
  finishedAt: number;
};

const LOGIN_LIFETIME_MS = 15 * 60 * 1_000;
const FINISHED_RETENTION_MS = 10 * 60 * 1_000;
const OUTPUT_LIMIT = 64 * 1_024;
const sessions = new Map<string, InternalSession>();

function accountKey(provider: Provider, source: AccountSource, email: string): string {
  return `${provider}:${source}:${source === "primary" ? "primary" : email.toLowerCase()}`;
}

function isActive(status: AccountLoginSession["status"]): status is ActiveStatus {
  return status === "starting" || status === "awaiting_code" || status === "waiting";
}

function publicSession(session: InternalSession): AccountLoginSession {
  return {
    id: session.id,
    provider: session.provider,
    source: session.source,
    email: session.email,
    status: session.status,
    url: isActive(session.status) ? session.url : null,
    userCode: isActive(session.status) ? session.userCode : null,
    message: session.message,
    startedAt: session.startedAt,
    expiresAt: session.expiresAt,
  };
}

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (!isActive(session.status) && session.finishedAt > 0 && now - session.finishedAt > FINISHED_RETENTION_MS) {
      sessions.delete(id);
    }
  }
}

function providerBinary(provider: Provider): string | null {
  const shimDir = join(AGENT_LINK_HOME_DIR, "bin");
  return searchPath()
    .filter((directory) => directory !== shimDir)
    .map((directory) => join(directory, provider))
    .find(existsSync) ?? null;
}

function authEnvironment(provider: Provider, source: AccountSource, configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: searchPath().join(delimiter),
    NO_COLOR: "1",
    // The browser belongs to the Paseo client, which may not be on the daemon
    // machine. Suppress the CLI's local opener and return the verified URL.
    BROWSER: existsSync("/usr/bin/false") ? "/usr/bin/false" : "false",
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  if (source !== "primary") env[provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = configDir;
  return env;
}

const AUTHENTICATION_FAILURE = /authenticat|not logged|login required|unauthori[sz]ed|revoked|expired token|api error:\s*401/i;

function fileText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function clearAuthenticationHold(session: InternalSession): void {
  const key = session.source === "primary" ? "primary" : session.email;
  const root = join(AGENT_LINK_HOME_DIR, "state", "pools");
  const holdPath = join(root, `hold-${session.provider}-${key}`);
  const reasonPath = join(root, `reason-${session.provider}-${key}`);
  if (AUTHENTICATION_FAILURE.test(fileText(holdPath))) rmSync(holdPath, { force: true });
  if (AUTHENTICATION_FAILURE.test(fileText(reasonPath))) rmSync(reasonPath, { force: true });
}

function verifyLogin(session: InternalSession): { ok: boolean; message: string } {
  const actualEmail = session.provider === "claude"
    ? claudeAccountEmail(session.configDir)
    : codexAccountEmail(session.configDir);
  const loggedIn = session.provider === "claude"
    ? (() => {
        const binary = providerBinary("claude");
        if (!binary) return false;
        try {
          const result = execFileSync(binary, ["auth", "status", "--json"], {
            encoding: "utf8",
            timeout: 5_000,
            env: authEnvironment("claude", session.source, session.configDir),
          });
          return (JSON.parse(result) as { loggedIn?: boolean }).loggedIn === true;
        } catch {
          return false;
        }
      })()
    : (() => {
        const binary = providerBinary("codex");
        if (!binary) return false;
        try {
          execFileSync(binary, ["login", "status"], {
            encoding: "utf8",
            timeout: 5_000,
            env: authEnvironment("codex", session.source, session.configDir),
          });
          return true;
        } catch {
          return false;
        }
      })();

  if (!loggedIn) return { ok: false, message: "The provider closed without saving a valid sign-in. Start again." };
  if (session.source !== "primary" && !actualEmail) {
    return { ok: false, message: "The provider signed in, but its account identity could not be verified. Start again." };
  }
  if (
    session.source !== "primary" &&
    normalizeAccountEmail(actualEmail) !== normalizeAccountEmail(session.email)
  ) {
    return { ok: false, message: `Signed in as ${actualEmail}, but this slot is for ${session.email}. Start again and choose the named account.` };
  }
  return { ok: true, message: actualEmail ? `Signed in as ${actualEmail}.` : "Sign-in complete." };
}

function finish(session: InternalSession, status: "succeeded" | "failed" | "cancelled", message: string): void {
  if (!isActive(session.status)) return;
  clearTimeout(session.timeout);
  session.status = status;
  session.message = message;
  session.url = null;
  session.userCode = null;
  session.finishedAt = Date.now();
  if (status === "succeeded") clearAuthenticationHold(session);
}

function failureMessage(session: InternalSession, exitCode: number | null): string {
  const output = stripTerminal(session.output).toLowerCase();
  if (output.includes("status code 400") || output.includes("invalid authorization code") || output.includes("code was rejected")) {
    return "That one-time code was rejected or expired. Start again for a fresh code.";
  }
  if (output.includes("device code") && output.includes("expired")) return "The device code expired. Start again for a fresh code.";
  return `Sign-in did not complete${exitCode === null ? "" : ` (provider exit ${exitCode})`}. Start again.`;
}

function consumeOutput(session: InternalSession, chunk: Buffer | string): void {
  session.output = `${session.output}${chunk.toString()}`.slice(-OUTPUT_LIMIT);
  if (!isActive(session.status)) return;
  session.url ??= trustedAuthUrl(session.provider, session.output);
  if (session.provider === "claude" && session.url && /Paste code here if prompted\s*>/i.test(stripTerminal(session.output))) {
    session.status = "awaiting_code";
    session.message = "Finish in your browser, then paste Claude's one-time code here.";
    return;
  }
  if (session.provider === "codex") {
    session.userCode ??= deviceCode(session.output);
    if (session.url && session.userCode) {
      session.status = "waiting";
      session.message = "Enter the copied device code in ChatGPT. AgentLink will finish automatically.";
    }
  }
}

async function waitForReady(session: InternalSession): Promise<AccountLoginSession> {
  const deadline = Date.now() + 8_000;
  while (session.status === "starting" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return publicSession(session);
}

function resolveConfigDir(provider: Provider, source: AccountSource, email: string): string {
  if (source === "agent-link") ensureManagedAccountSlot(provider, email);
  const dir = accountConfigDir(provider, source, email);
  if (!dir) throw new Error(source === "external" ? "That external sign-in folder no longer exists." : "That account could not be resolved.");
  return dir;
}

export function handleAccountLoginSessions() {
  pruneSessions();
  return { sessions: [...sessions.values()].map(publicSession).sort((a, b) => b.startedAt - a.startedAt) };
}

export async function handleAccountLoginStart({
  provider,
  source,
  email,
}: {
  provider: Provider;
  source: AccountSource;
  email: string;
}) {
  pruneSessions();
  const normalizedEmail = email.trim();
  if (source !== "primary" && !/^[^\s/\\]+@[^\s/\\]+$/.test(normalizedEmail)) throw new Error("Enter the account email to connect.");
  const key = accountKey(provider, source, normalizedEmail);
  const existing = [...sessions.values()].find((session) => session.accountKey === key && isActive(session.status));
  if (existing) return waitForReady(existing);

  const binary = providerBinary(provider);
  if (!binary) throw new Error(`Install the ${provider === "claude" ? "Claude Code" : "Codex"} CLI before signing in.`);
  const configDir = resolveConfigDir(provider, source, normalizedEmail);
  const args = provider === "claude"
    ? ["auth", "login", ...(normalizedEmail ? ["--email", normalizedEmail] : [])]
    : ["login", "--device-auth"];
  const child = spawn(binary, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: authEnvironment(provider, source, configDir),
    windowsHide: true,
  });
  const now = Date.now();
  const session: InternalSession = {
    id: randomUUID(),
    accountKey: key,
    provider,
    source,
    email: normalizedEmail,
    configDir,
    status: "starting",
    url: null,
    userCode: null,
    message: "Starting secure sign-in…",
    startedAt: now,
    expiresAt: now + LOGIN_LIFETIME_MS,
    child,
    output: "",
    timeout: setTimeout(() => {
      finish(session, "failed", "The sign-in expired. Start again for a fresh code.");
      child.kill("SIGTERM");
    }, LOGIN_LIFETIME_MS),
    finishedAt: 0,
  };
  sessions.set(session.id, session);
  child.stdout.on("data", (chunk) => consumeOutput(session, chunk));
  child.stderr.on("data", (chunk) => consumeOutput(session, chunk));
  child.on("error", (error) => finish(session, "failed", `Could not start ${provider}: ${error.message}`));
  child.on("close", (code) => {
    if (!isActive(session.status)) return;
    if (code !== 0) {
      finish(session, "failed", failureMessage(session, code));
      return;
    }
    const result = verifyLogin(session);
    finish(session, result.ok ? "succeeded" : "failed", result.message);
  });
  return waitForReady(session);
}

export function handleAccountLoginSubmit({ sessionId, code }: { sessionId: string; code: string }) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("That sign-in session is no longer available. Start again.");
  if (session.provider !== "claude" || session.status !== "awaiting_code") throw new Error("This sign-in is not waiting for a Claude code.");
  const value = code.trim();
  if (!value || /[\r\n\u0000]/.test(value)) throw new Error("Paste the complete one-time code on one line.");
  session.status = "waiting";
  session.message = "Claude is validating the one-time code…";
  session.child.stdin.write(`${value}\n`);
  return publicSession(session);
}

export function handleAccountLoginCancel({ sessionId }: { sessionId: string }) {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("That sign-in session is no longer available.");
  if (isActive(session.status)) {
    finish(session, "cancelled", "Sign-in cancelled.");
    session.child.kill("SIGTERM");
  }
  return publicSession(session);
}

onShutdown(() => {
  for (const session of sessions.values()) {
    if (!isActive(session.status)) continue;
    finish(session, "cancelled", "Sign-in cancelled because the plugin reloaded.");
    session.child.kill("SIGTERM");
  }
});
