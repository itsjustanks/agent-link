import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { findBinary } from "./router.server";

const run = promisify(execFile);

const BACKUP_SUFFIX = ".bak-agent-link-powerup";

/**
 * Power-ups modify packages this plugin does not own. Two rules keep that
 * honest: every change is backed up next to the file it edits, and every read
 * re-derives state from disk rather than trusting a stored flag — an upgrade
 * silently reverts these, and a panel claiming otherwise would be lying.
 */

export type PowerUp = {
  id: string;
  title: string;
  detail: string;
  applied: boolean;
  available: boolean;
  status: string;
  caution: string;
  action: "toggle" | "run";
};

/** The installed Claude Code version, or null when it is missing. */
export async function claudeVersion(): Promise<string | null> {
  try {
    const { stdout } = await run("claude", ["--version"], { timeout: 5_000 });
    const found = stdout.trim().match(/\d+\.\d+\.\d+/);
    return found?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Where 9router's compiled server chunks live. Resolved from the binary on
 * PATH so this works regardless of the npm prefix — a global install can sit
 * under a user prefix, a version manager, or /usr/local.
 */
function chunkDir(): string | null {
  const binary = findBinary("9router");
  if (!binary) return null;
  // npm puts a symlink in bin/; the package itself is wherever it resolves to.
  const candidates = [
    join(dirname(binary), "..", "lib", "node_modules", "9router"),
    join(dirname(binary), "node_modules", "9router"),
  ];
  try {
    candidates.unshift(dirname(realpathSync(binary)));
  } catch {
    // Keep the guesses.
  }
  for (const base of candidates) {
    const dir = join(base, "app", ".next-cli-build", "server", "chunks");
    if (existsSync(dir)) return dir;
  }
  return null;
}

const AGENT_RE = /claude-cli\/(\d+\.\d+\.\d+)/;

function chunkFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => join(dir, name))
      .filter((path) => {
        try {
          return AGENT_RE.test(readFileSync(path, "utf8"));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** Whatever version 9router currently claims to be, read from its own files. */
function advertisedVersion(dir: string): string | null {
  for (const path of chunkFiles(dir)) {
    const found = readFileSync(path, "utf8").match(AGENT_RE);
    if (found) return found[1] ?? null;
  }
  return null;
}

/**
 * Rewrite 9router's hardcoded client version to the one actually installed.
 *
 * 9router sends `claude-cli/<version>` rather than forwarding yours, so a model
 * Anthropic gates behind a newer client fails on every account. This only ever
 * writes the version `claude --version` reports: it corrects a stale claim, it
 * does not invent one, and it refuses outright when Claude Code is absent.
 */
async function applyVersionPatch(apply: boolean): Promise<{ ok: boolean; message: string }> {
  const dir = chunkDir();
  if (!dir) return { ok: false, message: "Could not find 9router's installed files." };

  if (!apply) {
    let restored = 0;
    const backups = readdirSync(dir).filter((name) => name.includes(".bak-") && name.includes("agent-link"));
    for (const path of backups) {
      const backup = join(dir, path);
      const original = backup.slice(0, backup.indexOf(".bak-", backup.lastIndexOf("/")));
      copyFileSync(backup, original);
      restored += 1;
    }
    if (restored === 0) return { ok: false, message: "No backup to restore — nothing was patched by this panel." };
    return { ok: true, message: `Restored ${restored} file(s) to 9router's shipped version.` };
  }

  const installed = await claudeVersion();
  if (!installed) {
    return { ok: false, message: "Claude Code is not installed, so there is no real version to write." };
  }
  const files = chunkFiles(dir);
  if (files.length === 0) return { ok: false, message: "9router's files do not carry a client version to patch." };

  const current = advertisedVersion(dir);
  if (current === installed) {
    return { ok: true, message: `9router already identifies as ${installed}.` };
  }

  let patched = 0;
  for (const path of files) {
    const before = readFileSync(path, "utf8");
    const after = before.replace(new RegExp(`claude-cli/${current?.replace(/\./g, "\\.")}`, "g"), `claude-cli/${installed}`)
      // The billing header carries the same version in a different shape.
      .replace(new RegExp(`cc_version=${current?.replace(/\./g, "\\.")}`, "g"), `cc_version=${installed}`);
    if (after === before) continue;
    const backup = `${path}${BACKUP_SUFFIX}`;
    if (!existsSync(backup)) copyFileSync(path, backup);
    const mode = statSync(path).mode & 0o777;
    const tmp = `${path}.tmp-agent-link`;
    writeFileSync(tmp, after, { mode });
    renameSync(tmp, path);
    patched += 1;
  }
  if (patched === 0) return { ok: false, message: "Found the version string but could not rewrite it." };
  return {
    ok: true,
    message: `9router now identifies as Claude Code ${installed} in ${patched} file(s). Restart 9router to load it.`,
  };
}

/** Update the Claude Code CLI in place, so the version being advertised is current. */
async function updateClaude(): Promise<{ ok: boolean; message: string }> {
  const before = await claudeVersion();
  if (!before) return { ok: false, message: "Claude Code is not installed." };
  try {
    // `claude update` is the supported path and knows how it was installed.
    const { stdout, stderr } = await run("claude", ["update"], { timeout: 180_000 });
    const after = await claudeVersion();
    const output = `${stdout}${stderr}`.trim().split("\n").slice(-1)[0] ?? "";
    if (after && before !== after) return { ok: true, message: `Claude Code ${before} → ${after}.` };
    return { ok: true, message: output || `Claude Code is already current (${before}).` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error) };
  }
}

export async function listPowerUps(): Promise<PowerUp[]> {
  const dir = chunkDir();
  const installed = await claudeVersion();
  const advertised = dir ? advertisedVersion(dir) : null;
  // "Applied" is the state we want to be in — the versions agreeing — not the
  // presence of our own backup. A patch applied by hand, or by an older build
  // using a different suffix, is still applied.
  const matched = Boolean(installed && advertised && installed === advertised);
  const hasBackups = dir ? readdirSync(dir).some((name) => name.includes(".bak-") && name.includes("agent-link")) : false;

  return [
    {
      id: "claude-version",
      title: "Match 9router's client version to yours",
      detail:
        "9router sends a hardcoded claude-cli/<version> instead of forwarding yours, so a model Anthropic gates behind a newer Claude Code fails on every account. This writes the version you actually have.",
      applied: matched,
      available: Boolean(dir && installed && (!matched || hasBackups)),
      status: !dir
        ? "9router's files were not found"
        : !installed
          ? "Claude Code is not installed"
          : advertised
            ? matched
              ? `both on ${installed}`
              : `9router says ${advertised}, you have ${installed}`
            : `you have ${installed}`,
      caution: "Edits 9router's installed files. Reversible here, but undone by the next `npm i -g 9router`.",
      action: "toggle",
    },
    {
      id: "claude-update",
      title: "Update Claude Code",
      detail:
        "Keeps the CLI current, so the version being advertised is a recent one. Worth running before the patch above.",
      applied: false,
      available: Boolean(installed),
      status: installed ? `installed: ${installed}` : "Claude Code is not installed",
      caution: "Runs `claude update`, which replaces the CLI on this machine.",
      action: "run",
    },
  ];
}

export async function applyPowerUp(id: string, apply: boolean): Promise<{ ok: boolean; message: string; restartRequired: boolean }> {
  if (id === "claude-version") {
    const result = await applyVersionPatch(apply);
    return { ...result, restartRequired: result.ok };
  }
  if (id === "claude-update") {
    const result = await updateClaude();
    return { ...result, restartRequired: false };
  }
  return { ok: false, message: `Unknown power-up: ${id}`, restartRequired: false };
}
