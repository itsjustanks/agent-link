import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./router.server";

/**
 * Uptime and restart history for the local 9router process.
 *
 * 9router's own /api/health returns only `{ok:true}` and every richer endpoint
 * (/api/status, /api/stats, /api/uptime) is behind the dashboard cookie, so a
 * panel that only had the password would still show nothing useful when the
 * router is wedged or the cookie has expired. The OS always knows, so uptime is
 * read from the process table instead: it works unauthenticated, and it keeps
 * working in exactly the states worth reporting.
 *
 * Restart history cannot come from the process table (a restarted process has
 * no memory of its predecessor), so each observed PID/start-time pair is
 * recorded here. That is what makes "last restart" and "restarts today"
 * answerable at a glance -- the question that actually matters after a session
 * drops mid-turn.
 */

const HISTORY_PATH = join(ROOT, "9router-uptime.json");
const MAX_EVENTS = 50;

export type UptimeEvent = {
  /** ISO timestamp the process was first observed running. */
  startedAt: string;
  /** ISO timestamp it was first observed gone; null while still running. */
  endedAt: string | null;
  pid: number;
};

export type UptimeInfo = {
  running: boolean;
  pid: number | null;
  /** Seconds the current process has been up; null when not running. */
  uptimeSeconds: number | null;
  startedAt: string | null;
  /** Resident set size in MB, for spotting a leak before it bites. */
  rssMb: number | null;
  /** When the router was last seen alive, if it is down now. */
  lastSeenAt: string | null;
  /** Duration of the previous run, so a crash-loop is visible. */
  previousRunSeconds: number | null;
  restartsToday: number;
  history: UptimeEvent[];
};

function readHistory(): UptimeEvent[] {
  try {
    const raw = JSON.parse(readFileSync(HISTORY_PATH, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is UptimeEvent =>
        typeof e === "object" && e !== null &&
        typeof (e as UptimeEvent).startedAt === "string" &&
        typeof (e as UptimeEvent).pid === "number",
    );
  } catch {
    return [];
  }
}

function writeHistory(events: UptimeEvent[]): void {
  try {
    if (!existsSync(ROOT)) mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const trimmed = events.slice(-MAX_EVENTS);
    const tmp = `${HISTORY_PATH}.tmp-agent-link`;
    writeFileSync(tmp, `${JSON.stringify(trimmed, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, HISTORY_PATH);
  } catch {
    // History is a convenience, never a reason to fail the status call.
  }
}

/**
 * BSD ps elapsed time: [[dd-]hh:]mm:ss. Returns null on anything unexpected so
 * a parse failure reads as "unknown", never as a bogus uptime.
 */
function parseEtime(value: string): number | null {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  const parts = clock.split(":").map((n) => Number(n));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  let seconds = 0;
  if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) seconds = parts[0] * 60 + parts[1];
  else return null;
  const d = Number(days);
  if (!Number.isFinite(d)) return null;
  return seconds + d * 86_400;
}

/**
 * The live 9router process, or null. Matched on the 9router bin path rather
 * than the bare word: the dashboard is a Next app whose child also mentions
 * 9router, and reporting the child's uptime would be wrong (it restarts
 * independently of the router that owns the port).
 */
function findProcess(): { pid: number; etimeSeconds: number; rssMb: number } | null {
  try {
    // `etimes` (seconds) is a Linux-ism; BSD/macOS ps only has `etime`, so the
    // elapsed field is parsed rather than read as a number. Verified against a
    // live router: asking for etimes here fails outright with
    // "ps: etimes: keyword not found" and would have reported the router down.
    const out = execFileSync("/bin/ps", ["-Ao", "pid=,etime=,rss=,command="], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of out.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+([\d:-]+)\s+(\d+)\s+(.*)$/);
      if (!match) continue;
      const command = match[4];
      // The supervisor invoked as `node .../bin/9router` or `.../9router/cli.js`.
      if (!/(\/9router\b|9router\/cli\.js)/.test(command)) continue;
      if (/next-server|bg-pty|--tray-child/.test(command)) continue;
      const elapsed = parseEtime(match[2]);
      if (elapsed === null) continue;
      return { pid: Number(match[1]), etimeSeconds: elapsed, rssMb: Math.round(Number(match[3]) / 1024) };
    }
  } catch {
    // ps unavailable or timed out; treat as unknown rather than down.
  }
  return null;
}

/**
 * Read current uptime and fold this observation into the history file.
 * Safe to call on every status refresh: it only appends on an actual
 * PID change, so polling does not inflate the restart count.
 */
export function readUptime(): UptimeInfo {
  const now = new Date();
  const proc = findProcess();
  const history = readHistory();
  const open = history.length > 0 && history[history.length - 1].endedAt === null
    ? history[history.length - 1]
    : null;

  if (proc) {
    const startedAt = new Date(now.getTime() - proc.etimeSeconds * 1_000).toISOString();
    if (!open || open.pid !== proc.pid) {
      // A different PID means the old run ended; close it at its last sighting.
      if (open) open.endedAt = startedAt;
      history.push({ startedAt, endedAt: null, pid: proc.pid });
      writeHistory(history);
    }
  } else if (open) {
    open.endedAt = now.toISOString();
    writeHistory(history);
  }

  const closed = history.filter((e) => e.endedAt !== null);
  const previous = closed.length > 0 ? closed[closed.length - 1] : null;
  const previousRunSeconds = previous
    ? Math.max(0, Math.round((Date.parse(previous.endedAt as string) - Date.parse(previous.startedAt)) / 1_000))
    : null;

  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  // The first run of the day is not a restart, so count starts after it.
  const startsToday = history.filter((e) => Date.parse(e.startedAt) >= midnight.getTime()).length;
  const restartsToday = Math.max(0, startsToday - 1);

  return {
    running: proc !== null,
    pid: proc?.pid ?? null,
    uptimeSeconds: proc?.etimeSeconds ?? null,
    startedAt: proc ? new Date(now.getTime() - proc.etimeSeconds * 1_000).toISOString() : null,
    rssMb: proc?.rssMb ?? null,
    lastSeenAt: previous?.endedAt ?? null,
    previousRunSeconds,
    restartsToday,
    history: history.slice(-10).reverse(),
  };
}

/**
 * Known-problem checks for the Claude Code -> 9router path.
 *
 * These exist because each cost real debugging time to find from a bare
 * 400 or a dropped session, and none of them is visible from either side
 * on its own: Claude Code thinks it sent a valid request, 9router thinks
 * it forwarded one, and only Anthropic's rejection shows the mismatch.
 */
export type RouterWarning = {
  id: string;
  title: string;
  detail: string;
  severity: "warning" | "danger";
};

const CLAUDE_JSON = join(homedir(), ".claude.json");

export function readWarnings(): RouterWarning[] {
  const warnings: RouterWarning[] = [];

  // `diagnostics` in the request body is only legal alongside the
  // claude-code-20250219 beta. Through 9router that beta does not reach
  // Anthropic, so the field comes back as
  // "diagnostics: Extra inputs are not permitted" (observed 2026-09-03) and
  // every turn in the session fails. The flag is a cached server-side value,
  // so it can silently flip back on -- worth surfacing, not just fixing once.
  try {
    const raw = JSON.parse(readFileSync(CLAUDE_JSON, "utf8")) as Record<string, unknown>;
    const flags = raw.cachedGrowthBookFeatures;
    if (flags && typeof flags === "object") {
      const value = (flags as Record<string, unknown>).tengu_prompt_cache_diagnostics;
      if (value === true) {
        warnings.push({
          id: "prompt-cache-diagnostics",
          title: "Claude Code will send a field 9router cannot pass through",
          detail:
            "tengu_prompt_cache_diagnostics is on, so Claude Code adds a `diagnostics` field that Anthropic " +
            "only accepts with the claude-code-20250219 beta -- which does not survive the 9router hop. New " +
            "sessions will fail with \"diagnostics: Extra inputs are not permitted\". Set it to false in " +
            "~/.claude.json, then restart affected sessions (running ones keep the old value in memory).",
          severity: "danger",
        });
      }
    }
  } catch {
    // No file or unreadable JSON: nothing to warn about.
  }

  return warnings;
}
