import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { onShutdown, onStart } from "./lifecycle.shared";
import { parseProcessTable, paseoTypechecks, planGovernorActions, type ProcessRow } from "./resources.logic";
import type { ResourceEvent, ResourceProcess, ResourceStatus } from "./resources.shared";

// This governor is intentionally narrow. It does not kill agents, cap Node's
// heap or touch work launched from Terminal. It only SIGSTOPs TypeScript checks
// below Paseo provider processes, then SIGCONTs them when their lane is free.
const HOME = homedir();
const ROOT = (() => {
  const explicit = process.env.AGENT_LINK_HOME ?? process.env.AGENT_AUTH_HOME;
  if (explicit) return explicit;
  const link = join(HOME, ".agent-link");
  const auth = join(HOME, ".agent-auth");
  return existsSync(join(link, "accounts")) || !existsSync(join(auth, "accounts")) ? link : auth;
})();
const STATE_PATH = join(ROOT, "state", "paseo-resource-governor.json");
const EVENT_KEEP = 20;
const MAX_ACTIVE = positiveInt(process.env.AGENT_LINK_TYPECHECK_CONCURRENCY, 1);
const PAUSE_AT_PERCENT = percent(process.env.AGENT_LINK_MEMORY_PAUSE_PERCENT, 15);
const RESUME_AT_PERCENT = Math.max(PAUSE_AT_PERCENT + 1, percent(process.env.AGENT_LINK_MEMORY_RESUME_PERCENT, 25));
const POLL_MS = positiveInt(process.env.AGENT_LINK_RESOURCE_POLL_SECONDS, 5) * 1000;
const PRESSURE_MIN_RSS_KB = 512 * 1024;

type PausedRecord = ResourceProcess & { fingerprint: string };
type Persisted = { enabled: boolean; paused: PausedRecord[]; events: ResourceEvent[] };

let state = loadState();
let timer: ReturnType<typeof setInterval> | null = null;
let watching = false;
let freePercent: number | null = null;
let activeTypechecks = 0;
let ticking = false;

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function percent(raw: string | undefined, fallback: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback;
}

function loadState(): Persisted {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<Persisted>;
    return {
      enabled: raw.enabled !== false,
      paused: Array.isArray(raw.paused) ? raw.paused : [],
      events: Array.isArray(raw.events) ? raw.events.slice(0, EVENT_KEEP) : [],
    };
  } catch {
    return { enabled: true, paused: [], events: [] };
  }
}

function saveState(): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

function processes(): ProcessRow[] {
  try {
    return parseProcessTable(
      execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,state=,etime=,command="], {
        encoding: "utf8",
        timeout: 4_000,
        maxBuffer: 8 * 1024 * 1024,
      }),
    );
  } catch {
    return [];
  }
}

function currentFreePercent(): number | null {
  if (process.platform === "darwin") {
    try {
      const output = execFileSync("/usr/bin/memory_pressure", ["-Q"], { encoding: "utf8", timeout: 4_000 });
      const match = /free percentage:\s*(\d+)%/i.exec(output);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "linux") {
    try {
      const text = readFileSync("/proc/meminfo", "utf8");
      const total = Number(/^MemTotal:\s+(\d+)/m.exec(text)?.[1] ?? 0);
      const available = Number(/^MemAvailable:\s+(\d+)/m.exec(text)?.[1] ?? 0);
      return total > 0 ? Math.round((available / total) * 100) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function fingerprint(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

function label(command: string): string {
  const compact = command
    .replace(/^\S*node\s+/, "")
    .replace(/\S*node_modules\/(?:\.bin\/|typescript\/(?:bin|lib)\/)/, "")
    .replace(/\s+/g, " ")
    .trim();
  return compact.slice(0, 160) || "TypeScript type-check";
}

function rssMb(row: ProcessRow): number {
  return Math.max(1, Math.round(row.rssKb / 1024));
}

function record(row: ProcessRow, action: "paused" | "resumed", reason: string): void {
  state.events = [
    { at: new Date().toISOString(), action, pid: row.pid, rssMb: rssMb(row), label: label(row.command), reason },
    ...state.events,
  ].slice(0, EVENT_KEEP);
}

function pause(row: ProcessRow, reason: string): void {
  if (state.paused.some((entry) => entry.pid === row.pid)) return;
  try {
    process.kill(row.pid, "SIGSTOP");
    state.paused.push({
      pid: row.pid,
      rssMb: rssMb(row),
      label: label(row.command),
      pausedAt: new Date().toISOString(),
      fingerprint: fingerprint(row.command),
    });
    record(row, "paused", reason);
    console.log(`[agent-link] paused Paseo type-check ${row.pid}: ${reason}`);
  } catch {
    // It normally finished between ps and the signal — nothing to protect.
  }
}

function resume(row: ProcessRow, reason: string): void {
  const owned = state.paused.find((entry) => entry.pid === row.pid);
  if (!owned || owned.fingerprint !== fingerprint(row.command)) return;
  try {
    process.kill(row.pid, "SIGCONT");
    record(row, "resumed", reason);
    console.log(`[agent-link] resumed Paseo type-check ${row.pid}: ${reason}`);
  } catch {
    // A completed process needs no recovery.
  } finally {
    state.paused = state.paused.filter((entry) => entry.pid !== row.pid);
  }
}

function reconcile(rows: ProcessRow[]): void {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  state.paused = state.paused.filter((entry) => {
    const row = byPid.get(entry.pid);
    return Boolean(row && row.state.includes("T") && entry.fingerprint === fingerprint(row.command));
  });
}

function tick(): void {
  if (ticking) return;
  ticking = true;
  let candidates: ProcessRow[] = [];
  let ownedBefore = new Set<number>();
  try {
    const rows = processes();
    if (rows.length === 0) return;
    reconcile(rows);
    candidates = paseoTypechecks(rows);
    const candidatePids = new Set(candidates.map((row) => row.pid));
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    for (const entry of [...state.paused]) {
      const row = byPid.get(entry.pid);
      if (row && !candidatePids.has(entry.pid)) resume(row, "process left the Paseo agent tree");
    }
    freePercent = currentFreePercent();
    activeTypechecks = candidates.filter((row) => !row.state.includes("T")).length;
    if (!state.enabled) {
      for (const row of candidates) resume(row, "guard disabled");
      return;
    }
    ownedBefore = new Set(state.paused.map((entry) => entry.pid));
    const plan = planGovernorActions(candidates, ownedBefore, freePercent, {
      maxActive: MAX_ACTIVE,
      pauseAtPercent: PAUSE_AT_PERCENT,
      resumeAtPercent: RESUME_AT_PERCENT,
      pressureMinRssKb: PRESSURE_MIN_RSS_KB,
    });
    const pauseReason =
      plan.reason === "pressure"
        ? `memory pressure (${freePercent}% available)`
        : `another Paseo type-check is already running (limit ${MAX_ACTIVE})`;
    for (const row of plan.pause) pause(row, pauseReason);
    for (const row of plan.resume) resume(row, `memory recovered; type-check lane available`);
  } finally {
    const pausedNow = new Set(state.paused.map((entry) => entry.pid));
    activeTypechecks = candidates.filter(
      (row) => !pausedNow.has(row.pid) && (!row.state.includes("T") || ownedBefore.has(row.pid)),
    ).length;
    try {
      saveState();
    } finally {
      ticking = false;
    }
  }
}

function resumeOwnedAfterRestart(): void {
  const rows = processes();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const entry of [...state.paused]) {
    const row = byPid.get(entry.pid);
    if (row && row.state.includes("T") && entry.fingerprint === fingerprint(row.command)) {
      resume(row, "resource governor restarted");
    } else {
      state.paused = state.paused.filter((item) => item.pid !== entry.pid);
    }
  }
  saveState();
}

function start(): void {
  if (timer) return;
  watching = true;
  resumeOwnedAfterRestart();
  tick();
  timer = setInterval(tick, POLL_MS);
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  watching = false;
  const byPid = new Map(processes().map((row) => [row.pid, row]));
  for (const entry of [...state.paused]) {
    const row = byPid.get(entry.pid);
    if (row) resume(row, "resource governor stopped");
  }
  state.paused = [];
  saveState();
}

function status(): ResourceStatus {
  return {
    watching,
    enabled: state.enabled,
    freePercent,
    activeTypechecks,
    paused: state.paused.map(({ fingerprint: _fingerprint, ...entry }) => entry),
    events: state.events,
  };
}

onStart(start);
onShutdown(stop);

export function handleResourceStatus(): ResourceStatus {
  return status();
}

export function handleResourceSetEnabled({ enabled }: { enabled: boolean }): ResourceStatus {
  state.enabled = enabled;
  saveState();
  tick();
  return status();
}
