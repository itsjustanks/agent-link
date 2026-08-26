import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LimitEvent, LimitsStatus } from "./limits.shared";
import { onShutdown } from "./lifecycle.shared";

// ---------------------------------------------------------------- the sentry
//
// Handlers receive `paseo` per call, and PluginContext has no paseo at all —
// so a resident subscription can only be armed lazily, from the first RPC the
// panel makes after the daemon starts. Every handler in this plugin calls
// ensureLimitSentry(paseo); arming is idempotent.
//
// What it does: subscribes to the daemon's agent_update stream. When an agent
// enters "error", it reads that agent's recent timeline; only a genuine
// limit/billing failure counts (an agent merely TALKING about limits stays
// untouched, same rule as the CLI's transcript parser — we look at error-ish
// entries, not chat). With auto on, it sends the agent one continuation nudge:
// Paseo relaunches the provider process to serve it, the agent-link launcher
// reroutes the resume to a healthy account, and the chat carries on. With auto
// off, the event is listed in the panel with a Resume button.

const HOME = homedir();
const STATE_PATH = (() => {
  const explicit = process.env.AGENT_LINK_HOME ?? process.env.AGENT_AUTH_HOME;
  const root =
    explicit && existsSync(explicit)
      ? explicit
      : existsSync(join(HOME, ".agent-auth", "accounts"))
        ? join(HOME, ".agent-auth")
        : join(HOME, ".agent-link");
  return join(root, "state", "paseo-limit-sentry.json");
})();

const LIMIT_ERROR = /usage limit|rate limit|spend limit|limit reached|billing|out of credits|quota exceeded/i;
// Every provider's limit-death is worth SHOWING; only providers with an
// account pool behind them are worth auto-nudging — for the rest a retry just
// hammers the same exhausted account, so the human picks the moment.
const ROUTED_PROVIDERS = /^(claude|codex)/;
const NUDGE =
  "You stopped because the provider account hit its usage limit. The account router has moved this conversation to a healthy account. Continue the task exactly where you left off; do not redo completed work. If the remaining work is long-running and you have Paseo tools, create a heartbeat (for example every 10 minutes, stopping when the task is complete) so you keep making progress without supervision.";
const EVENT_KEEP = 20;
const DEBOUNCE_MS = 5 * 60 * 1000;
const NON_LIMIT_GUARD_MS = 20 * 1000;
// Claude Code delivers a limit refusal as a normal synthetic assistant
// message: the turn COMPLETES and the agent settles at "idle", never "error".
// So idle transitions get a cheap check of just the newest timeline entry for
// the refusal phrasing — the error path alone would miss every such death.
const REFUSAL_TEXT = /you've hit your [^.!\n]{0,40}limit|usage limit reached|monthly spend limit|spend limit reached/i;
const IDLE_CHECK_GUARD_MS = 60 * 1000;
const lastIdleCheck = new Map<string, number>();

type PaseoLike = {
  agents: {
    list(options?: Record<string, unknown>): Promise<unknown>;
    subscribe(handler: (update: unknown) => void): () => void;
    ref(id: string): {
      send(text: string): Promise<void>;
      timeline: { refetch(options?: { limit?: number }): Promise<unknown> };
      refresh(): Promise<unknown>;
      current(): unknown;
      archive(): Promise<unknown>;
    };
  };
};

type Persisted = { auto: boolean; events: LimitEvent[] };

let armed = false;
let unsubscribe: (() => void) | null = null;
let lastPaseo: PaseoLike | null = null;
const lastSeen = new Map<string, number>();

function loadState(): Persisted {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Persisted;
    // Auto is the point of the sentry, so it defaults ON; the toggle records
    // an explicit false when the user turns it off.
    return { auto: raw.auto !== false, events: Array.isArray(raw.events) ? raw.events : [] };
  } catch {
    return { auto: true, events: [] };
  }
}

function saveState(state: Persisted): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

function record(event: LimitEvent): void {
  const state = loadState();
  state.events = [event, ...state.events.filter((e) => e.agentId !== event.agentId)].slice(0, EVENT_KEEP);
  saveState(state);
}

function snapshotOf(update: unknown): { id?: string; status?: string; attentionReason?: string | null; provider?: string; workspaceId?: string | null; title?: string | null } {
  const u = update as Record<string, unknown>;
  const snap = (u?.agent ?? u) as Record<string, unknown>;
  return {
    id: typeof snap?.id === "string" ? snap.id : undefined,
    status: typeof snap?.status === "string" ? snap.status : undefined,
    attentionReason: typeof snap?.attentionReason === "string" ? snap.attentionReason : null,
    provider: typeof snap?.provider === "string" ? snap.provider : "",
    workspaceId: typeof snap?.workspaceId === "string" ? snap.workspaceId : null,
    title: typeof snap?.title === "string" ? snap.title : null,
  };
}

async function diedOnLimit(paseo: PaseoLike, agentId: string): Promise<string | null> {
  try {
    const page = await paseo.agents.ref(agentId).timeline.refetch({ limit: 25 });
    const entries = ((page as Record<string, unknown>)?.entries ?? []) as unknown[];
    // Only genuinely errored entries count, and only their ERROR TEXT is
    // searched. Timeline items carry an \`error: null\` field even on success,
    // and tool-call payloads can quote rate-limit-related code or output — a
    // regex over the whole serialized entry would nudge agents that died of
    // something else entirely, with a fabricated premise.
    for (const entry of [...entries].reverse()) {
      const e = entry as Record<string, unknown>;
      const item = (e.item ?? {}) as Record<string, unknown>;
      const kindText = [e.type, e.kind, e.status, item.type, item.status]
        .filter((v): v is string => typeof v === "string")
        .join(" ");
      const errValue = e.error ?? item.error ?? (e.payload as Record<string, unknown> | undefined)?.error;
      const isError = /error|failed|failure/i.test(kindText) || (errValue !== undefined && errValue !== null && errValue !== false);
      if (!isError) continue;
      const searchable =
        errValue !== undefined && errValue !== null
          ? JSON.stringify(errValue)
          : [e.message, e.text, item.message, item.text].filter((v) => typeof v === "string").join(" ");
      const match = LIMIT_ERROR.exec(searchable);
      if (match) return match[0];
    }
  } catch {
    // Timeline unavailable — err on the quiet side.
  }
  return null;
}

// The newest timeline entry's text, when it is a message-ish entry.
async function newestEntryRefusal(paseo: PaseoLike, agentId: string): Promise<string | null> {
  try {
    const page = await paseo.agents.ref(agentId).timeline.refetch({ limit: 3 });
    const entries = ((page as Record<string, unknown>)?.entries ?? []) as unknown[];
    const last = entries[entries.length - 1] as Record<string, unknown> | undefined;
    if (!last) return null;
    const item = (last.item ?? {}) as Record<string, unknown>;
    const text = [last.text, last.message, item.text, item.message]
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    const match = REFUSAL_TEXT.exec(text);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

async function handleErroredAgent(paseo: PaseoLike, update: unknown): Promise<void> {
  const snap = snapshotOf(update);
  // An ACP agent whose turn failed can settle as idle-with-attention rather
  // than "error" — both shapes mean the same thing here.
  const errored = snap.status === "error" || snap.attentionReason === "error";
  if (!snap.id) return;
  if (!errored && snap.status === "idle") {
    // Synthetic-refusal path: turn completed normally, but its final message
    // is the provider saying no. Only the newest entry counts — a refusal
    // deeper in the chat already had its chance.
    const now = Date.now();
    if (now - (lastIdleCheck.get(snap.id) ?? 0) < IDLE_CHECK_GUARD_MS) return;
    lastIdleCheck.set(snap.id, now);
    if (now - (lastSeen.get(snap.id) ?? 0) < DEBOUNCE_MS) return;
    const refusal = await newestEntryRefusal(paseo, snap.id);
    if (!refusal) return;
    lastSeen.set(snap.id, now);
    await actOnLimitDeath(paseo, snap, now, refusal);
    return;
  }
  if (!errored) return;
  const now = Date.now();
  const seen = lastSeen.get(snap.id) ?? 0;
  if (now - seen < DEBOUNCE_MS) return;
  const matched = await diedOnLimit(paseo, snap.id);
  if (!matched) {
    // A non-limit error must not swallow a limit death moments later — hold
    // only a short guard against timeline-refetch flapping.
    lastSeen.set(snap.id, now - DEBOUNCE_MS + NON_LIMIT_GUARD_MS);
    return;
  }
  lastSeen.set(snap.id, now);
  await actOnLimitDeath(paseo, snap, now, matched);
}

async function actOnLimitDeath(
  paseo: PaseoLike,
  snap: ReturnType<typeof snapshotOf>,
  now: number,
  matched: string,
): Promise<void> {
  if (!snap.id) return;
  const base = {
    agentId: snap.id,
    workspaceId: snap.workspaceId ?? null,
    title: snap.title ?? null,
    provider: snap.provider ?? "",
    at: new Date(now).toISOString(),
  };
  const routed = ROUTED_PROVIDERS.test(snap.provider ?? "");
  if (!loadState().auto || !routed) {
    record({
      ...base,
      action: "needs-resume",
      detail: routed ? matched : `${matched} — no account pool for this provider; resume when its limit resets`,
    });
    return;
  }
  try {
    await paseo.agents.ref(snap.id).send(NUDGE);
    record({ ...base, action: "auto-resumed", detail: matched });
  } catch (error) {
    record({ ...base, action: "resume-failed", detail: `${matched}: ${String(error)}` });
  }
}

// Janitor: every live agent holds its whole timeline in the daemon's JS heap,
// and heap pressure is what starts the eviction spiral (dead runtimes, blank
// tabs). Agents idle for over a day are finished work nobody archived — sweep
// them into the archive, a few at a time, once an hour. Soft-delete only:
// archived agents remain in the archived list.
const JANITOR_IDLE_MS = 24 * 60 * 60 * 1000;
const JANITOR_INTERVAL_MS = 60 * 60 * 1000;
const JANITOR_BATCH = 10;
let janitorTimer: ReturnType<typeof setInterval> | null = null;

async function janitorSweep(paseo: PaseoLike): Promise<void> {
  try {
    const page = (await paseo.agents.list({})) as { entries?: unknown[] };
    const now = Date.now();
    let archived = 0;
    for (const raw of page.entries ?? []) {
      if (archived >= JANITOR_BATCH) break;
      const snap = ((raw as Record<string, unknown>).agent ?? raw) as Record<string, unknown>;
      const id = typeof snap.id === "string" ? snap.id : "";
      const status = typeof snap.status === "string" ? snap.status : "";
      const last = typeof snap.lastActivityAt === "string" ? Date.parse(snap.lastActivityAt) : NaN;
      if (!id || (status !== "idle" && status !== "closed")) continue;
      if (!Number.isFinite(last) || now - last < JANITOR_IDLE_MS) continue;
      try {
        await paseo.agents.ref(id).archive();
        archived += 1;
      } catch {
        // an agent that refuses to archive is left alone
      }
    }
    if (archived > 0) console.log(`[agent-link] janitor archived ${archived} agents idle >24h`);
  } catch {
    // list unavailable — try again next hour
  }
}

export function ensureLimitSentry(paseo: unknown): void {
  lastPaseo = paseo as PaseoLike;
  if (armed) return;
  const p = paseo as PaseoLike;
  if (typeof p?.agents?.subscribe !== "function") return;
  unsubscribe = p.agents.subscribe((update) => {
    void handleErroredAgent(p, update).catch(() => {});
  });
  // subscribe() is only a local listener; the daemon streams agent updates
  // once a directory subscription exists. Without this, the sentry hears
  // nothing when no app window is attached.
  try {
    void Promise.resolve(p.agents.list({ subscribe: {} })).catch(() => {});
  } catch {
    // An older daemon without subscription support still works panel-side.
  }
  if (!janitorTimer) {
    janitorTimer = setInterval(() => void janitorSweep(p), JANITOR_INTERVAL_MS);
    void janitorSweep(p);
  }
  armed = true;
}

onShutdown(() => {
  try {
    unsubscribe?.();
  } finally {
    unsubscribe = null;
    armed = false;
    if (janitorTimer) {
      clearInterval(janitorTimer);
      janitorTimer = null;
    }
  }
});

// ---------------------------------------------------------------- handlers

type HandlerContext = { paseo: unknown };

export async function handleLimitsStatus(_input: Record<string, never>, { paseo }: HandlerContext): Promise<LimitsStatus> {
  ensureLimitSentry(paseo);
  const state = loadState();
  return { watching: armed, auto: state.auto, events: state.events };
}

export async function handleLimitsSetAuto({ auto }: { auto: boolean }, { paseo }: HandlerContext): Promise<LimitsStatus> {
  ensureLimitSentry(paseo);
  const state = loadState();
  state.auto = auto;
  saveState(state);
  return { watching: armed, auto, events: state.events };
}

export async function handleLimitsResume({ agentId }: { agentId: string }, { paseo }: HandlerContext): Promise<{ ok: boolean; error: string | null }> {
  ensureLimitSentry(paseo);
  const p = (paseo ?? lastPaseo) as PaseoLike | null;
  if (!p) return { ok: false, error: "no daemon connection yet" };
  try {
    await p.agents.ref(agentId).send(NUDGE);
    const state = loadState();
    state.events = state.events.map((e) => (e.agentId === agentId ? { ...e, action: "auto-resumed" as const } : e));
    saveState(state);
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}
