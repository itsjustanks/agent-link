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
const OUR_PROVIDERS = /^(claude|codex)/;
const NUDGE =
  "You stopped because the provider account hit its usage limit. The account router has moved this conversation to a healthy account. Continue the task exactly where you left off; do not redo completed work.";
const EVENT_KEEP = 20;
const DEBOUNCE_MS = 5 * 60 * 1000;

type PaseoLike = {
  agents: {
    subscribe(handler: (update: unknown) => void): () => void;
    ref(id: string): {
      send(text: string): Promise<void>;
      timeline: { refetch(options?: { limit?: number }): Promise<unknown> };
      refresh(): Promise<unknown>;
      current(): unknown;
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
    return { auto: raw.auto === true, events: Array.isArray(raw.events) ? raw.events : [] };
  } catch {
    return { auto: false, events: [] };
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
    // Only error-shaped entries count; a conversation about limits is not a
    // refusal. We do not know every entry variant, so: an entry whose own JSON
    // mentions an error marker AND a limit phrase.
    for (const entry of [...entries].reverse()) {
      const text = JSON.stringify(entry);
      if (!/"(error|failed|failure)"/i.test(text)) continue;
      const match = LIMIT_ERROR.exec(text);
      if (match) return match[0];
    }
  } catch {
    // Timeline unavailable — err on the quiet side.
  }
  return null;
}

async function handleErroredAgent(paseo: PaseoLike, update: unknown): Promise<void> {
  const snap = snapshotOf(update);
  // An ACP agent whose turn failed can settle as idle-with-attention rather
  // than "error" — both shapes mean the same thing here.
  const errored = snap.status === "error" || snap.attentionReason === "error";
  if (!snap.id || !errored) return;
  if (!OUR_PROVIDERS.test(snap.provider ?? "")) return;
  const now = Date.now();
  const seen = lastSeen.get(snap.id) ?? 0;
  if (now - seen < DEBOUNCE_MS) return;
  lastSeen.set(snap.id, now);
  const matched = await diedOnLimit(paseo, snap.id);
  if (!matched) return;
  const base = {
    agentId: snap.id,
    workspaceId: snap.workspaceId ?? null,
    title: snap.title ?? null,
    provider: snap.provider ?? "",
    at: new Date(now).toISOString(),
  };
  if (!loadState().auto) {
    record({ ...base, action: "needs-resume", detail: matched });
    return;
  }
  try {
    await paseo.agents.ref(snap.id).send(NUDGE);
    record({ ...base, action: "auto-resumed", detail: matched });
  } catch (error) {
    record({ ...base, action: "resume-failed", detail: `${matched}: ${String(error)}` });
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
  armed = true;
}

onShutdown(() => {
  try {
    unsubscribe?.();
  } finally {
    unsubscribe = null;
    armed = false;
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
