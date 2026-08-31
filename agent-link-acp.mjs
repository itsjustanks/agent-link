#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const VERSION = "0.8.3";
if (["--version", "-v", "version"].includes(process.argv[2])) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
const PROTOCOL_VERSION = 1;
const CONTEXT_LIMIT = Math.max(32_000, Number.parseInt(process.env.AGENT_LINK_CONTEXT_CHARS ?? "240000", 10) || 240_000);
const HOME = process.env.HOME || homedir();

function hasAccounts(root) {
  return ["claude", "codex"].some((provider) => {
    try {
      return readdirSync(join(root, "accounts", provider)).length > 0;
    } catch {
      return false;
    }
  });
}

function resolveRoot() {
  if (process.env.AGENT_LINK_HOME) return process.env.AGENT_LINK_HOME;
  if (process.env.AGENT_AUTH_HOME) return process.env.AGENT_AUTH_HOME;
  const link = join(HOME, ".agent-link");
  const auth = join(HOME, ".agent-auth");
  if (hasAccounts(link)) return link;
  if (hasAccounts(auth)) return auth;
  if (existsSync(link)) return link;
  if (existsSync(auth)) return auth;
  return link;
}

const ROOT = resolveRoot();
const ACCOUNTS = join(ROOT, "accounts");
const POOLS = join(ROOT, "state", "pools");
const SESSION_ROOT = join(ROOT, "state", "acp", "sessions");
const ATTACHMENT_ROOT = join(ROOT, "state", "acp", "attachments");
const PASEO_PROVIDER_CATALOG = join(ROOT, "state", "acp", "paseo-provider-catalog.json");
const ROUTER_CONFIG = join(ROOT, "router", "config.json");
const ROUTER_RULES = join(ROOT, "router", "rules.md");
const PASEO_CONFIG = join(HOME, ".paseo", "config.json");
mkdirSync(SESSION_ROOT, { recursive: true, mode: 0o700 });
mkdirSync(ATTACHMENT_ROOT, { recursive: true, mode: 0o700 });

let parentClientCapabilities = {};
let genericCatalog = null;
let genericCatalogPromise = null;
const sessionContexts = new Map();
const genericConnections = new Map();

const MODEL_CATALOG = {
  claude: [
    ["claude-fable-5", "Claude Fable 5"],
    ["claude-opus-5", "Claude Opus 5"],
    ["claude-opus-5[1m]", "Claude Opus 5 · 1M"],
    ["claude-sonnet-5", "Claude Sonnet 5"],
    ["claude-sonnet-5[1m]", "Claude Sonnet 5 · 1M"],
    ["claude-haiku-4-5", "Claude Haiku 4.5"],
  ],
  codex: [
    ["gpt-5.6-sol", "GPT-5.6 Sol"],
    ["gpt-5.6-terra", "GPT-5.6 Terra"],
    ["gpt-5.6-luna", "GPT-5.6 Luna"],
    ["gpt-5.5", "GPT-5.5"],
  ],
};

const ROUTER_PROFILE_ID = "agentlink.router.auto";
const ROUTER_DEFAULT_GROUPS = [
  {
    name: "fast",
    purpose: "Explanations, summaries, formatting and tiny edits",
    targets: [
      { provider: "claude", account: "auto", model: "claude-haiku-4-5" },
      { provider: "codex", account: "auto", model: "gpt-5.6-luna" },
    ],
  },
  {
    name: "planning",
    purpose: "Product and implementation plans",
    targets: [
      { provider: "claude", account: "auto", model: "claude-fable-5" },
      { provider: "codex", account: "auto", model: "gpt-5.6-terra" },
    ],
  },
  {
    name: "judgment",
    purpose: "Architecture, UI and UX, audits and final review",
    targets: [
      { provider: "claude", account: "auto", model: "claude-opus-5" },
      { provider: "codex", account: "auto", model: "gpt-5.6-sol" },
    ],
  },
  {
    name: "build",
    purpose: "Multi-file implementation, debugging, migrations and refactors",
    targets: [
      { provider: "codex", account: "auto", model: "gpt-5.6-sol" },
      { provider: "claude", account: "auto", model: "claude-opus-5" },
    ],
  },
  {
    name: "browser",
    purpose: "Browser-driving verification",
    targets: [{ provider: "codex", account: "auto", model: "gpt-5.6-sol" }],
  },
];

const MODES = {
  currentModeId: "auto",
  availableModes: [
    { id: "plan", name: "Plan", description: "Read and plan without changing files." },
    { id: "auto", name: "Auto", description: "Work in the workspace with provider-native safety checks." },
    { id: "full-access", name: "Full access", description: "Use the selected provider's unrestricted mode. This can edit files, run commands and access the network without approval." },
  ],
};
const MODE_IDS = new Set(MODES.availableModes.map((mode) => mode.id));
const ROUTER_MODE_IDS = new Set(["inherit", ...MODE_IDS]);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function sessionPath(sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("Invalid AgentLink session ID");
  return join(SESSION_ROOT, `${sessionId}.json`);
}

function loadStoredSession(sessionId) {
  const session = readJson(sessionPath(sessionId));
  if (!session || session.id !== sessionId || !Array.isArray(session.transcript)) {
    throw new Error(`AgentLink session ${sessionId} was not found`);
  }
  session.backends ||= {};
  if (!MODE_IDS.has(session.currentModeId)) session.currentModeId = "auto";
  return session;
}

function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  atomicJson(sessionPath(session.id), session);
}

function claudeEmail(configDir) {
  const path = configDir === HOME ? join(HOME, ".claude.json") : join(configDir, ".claude.json");
  return readJson(path)?.oauthAccount?.emailAddress ?? "";
}

function decodeJwtEmail(token) {
  try {
    const payload = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).email ?? "";
  } catch {
    return "";
  }
}

function codexEmail(configDir) {
  const token = readJson(join(configDir, "auth.json"))?.tokens?.id_token;
  return typeof token === "string" ? decodeJwtEmail(token) : "";
}

function accountRecords(provider) {
  const records = [];
  const primaryDir = provider === "claude" ? HOME : join(HOME, ".codex");
  const primaryEmail = provider === "claude" ? claudeEmail(primaryDir) : codexEmail(primaryDir);
  if (primaryEmail) records.push({ provider, key: "primary", email: primaryEmail, configDir: primaryDir, primary: true });
  const root = join(ACCOUNTS, provider);
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const configDir = join(root, entry.name);
      const email = provider === "claude" ? claudeEmail(configDir) : codexEmail(configDir);
      if (email) records.push({ provider, key: entry.name, email, configDir, primary: false });
    }
  } catch {
    // A provider with no saved accounts simply contributes no models.
  }
  const seen = new Set();
  return records.filter((record) => {
    const identity = `${provider}:${record.email.toLowerCase()}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function encodePart(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function profileId(provider, accountKey, model) {
  return `${provider}.${encodePart(accountKey)}.${encodePart(model)}`;
}

function genericProfile(definition, model) {
  const modelId = typeof model?.modelId === "string" ? model.modelId : model?.id;
  if (typeof modelId !== "string" || !modelId) return null;
  return {
    id: `paseo.${encodePart(definition.id)}.${encodePart(modelId)}`,
    kind: "paseo-acp",
    provider: definition.id,
    providerId: definition.id,
    model: modelId,
    modelLabel: typeof model.name === "string" && model.name
      ? model.name
      : typeof model.model === "string" && model.model
        ? model.model
        : modelId,
    accountKey: "provider",
    email: definition.label,
    configDir: "",
    primary: true,
    unavailable: "",
    command: definition.command,
    providerEnv: definition.env,
    clientCapabilities: definition.clientCapabilities,
    providerDescription: typeof model.description === "string" && model.description
      ? model.description
      : definition.description,
  };
}

function configuredAcpProviders() {
  const providers = readJson(PASEO_CONFIG)?.agents?.providers ?? {};
  const result = [];
  for (const [id, value] of Object.entries(providers)) {
    if (!value || typeof value !== "object" || id === "agent-link" || value.enabled === false || value.extends !== "acp") continue;
    if (!Array.isArray(value.command) || !value.command.every((part) => typeof part === "string") || value.command.length === 0) continue;
    if (basename(value.command[0]).startsWith("agent-link-acp")) continue;
    const env = {};
    if (value.env && typeof value.env === "object" && !Array.isArray(value.env)) {
      for (const [key, entry] of Object.entries(value.env)) if (typeof entry === "string") env[key] = entry;
    }
    result.push({
      id,
      label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : id,
      description: typeof value.description === "string" ? value.description : "",
      command: value.command,
      env,
      clientCapabilities: value.params?.clientCapabilities && typeof value.params.clientCapabilities === "object"
        ? value.params.clientCapabilities
        : {},
    });
  }
  return result;
}

async function probeAcpProvider(definition) {
  const connection = new NestedACPConnection(definition, { probe: true, cwd: HOME });
  try {
    await connection.start();
    const response = await connection.request("session/new", { cwd: HOME, mcpServers: [] });
    connection.childSessionId = response.sessionId;
    const models = Array.isArray(response.models?.availableModels) ? response.models.availableModels : [];
    return models.map((model) => genericProfile(definition, model)).filter(Boolean);
  } finally {
    await connection.close();
  }
}

function cachedAcpProfiles(definition) {
  const entry = readJson(PASEO_PROVIDER_CATALOG)?.providers?.[definition.id];
  if (!entry || !Array.isArray(entry.models)) return [];
  return entry.models.map((model) => genericProfile(definition, model)).filter(Boolean);
}

async function ensureGenericCatalog() {
  if (genericCatalog) return genericCatalog;
  if (!genericCatalogPromise) {
    const definitions = configuredAcpProviders();
    genericCatalogPromise = (async () => {
      const discovered = [];
      // The CLI writes this token-free catalog through Paseo's own provider
      // discovery. Prefer it so opening AgentLink's picker never starts every
      // connected ACP or creates their file watchers. Probe only a newly added
      // provider that has not been cached yet, and do that serially.
      for (const definition of definitions) {
        const cached = cachedAcpProfiles(definition);
        if (cached.length > 0) {
          discovered.push(...cached);
          continue;
        }
        try {
          const probed = await probeAcpProvider(definition);
          discovered.push(...probed);
        } catch (error) {
          process.stderr.write(`AgentLink skipped ${definition.label}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      genericCatalog = discovered;
      return genericCatalog;
    })();
  }
  return genericCatalogPromise;
}

function heldReason(provider, accountKey, model) {
  const modelKey = model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const modelHold = join(POOLS, `holdmodel-${provider}-${accountKey}-${modelKey}`);
  if (existsSync(modelHold)) return `this account is blocked for ${model}`;
  const hold = join(POOLS, `hold-${provider}-${accountKey}`);
  try {
    const reason = readFileSync(hold, "utf8").trim();
    if (reason) return reason;
  } catch {
    // Not held.
  }
  try {
    const until = Number.parseInt(readFileSync(join(POOLS, `cooldown-${provider}-${accountKey}`), "utf8").trim(), 10);
    if (Number.isFinite(until) && until > Date.now() / 1000) {
      return `cooling down until ${new Date(until * 1000).toLocaleString()}`;
    }
  } catch {
    // Not cooling down.
  }
  return "";
}

function profiles() {
  const result = [{
    id: ROUTER_PROFILE_ID,
    kind: "router",
    provider: "agent-link",
    model: "agent-router-auto",
    modelLabel: "AgentRouter",
    accountKey: "automatic",
    email: "Automatic route",
    configDir: "",
    primary: true,
    unavailable: "",
  }];
  for (const provider of ["claude", "codex"]) {
    for (const account of accountRecords(provider)) {
      for (const [model, modelLabel] of MODEL_CATALOG[provider]) {
        const unavailable = heldReason(provider, account.key, model);
        result.push({
          id: profileId(provider, account.key, model),
          provider,
          model,
          modelLabel,
          accountKey: account.key,
          email: account.email,
          configDir: account.configDir,
          primary: account.primary,
          unavailable,
        });
      }
    }
  }
  result.push(...(genericCatalog ?? []));
  return result;
}

function modelsState(currentModelId) {
  const available = profiles();
  const fallback =
    available.find((entry) => entry.id === ROUTER_PROFILE_ID) ??
    available.find((entry) => !entry.unavailable && entry.model === "gpt-5.6-sol") ??
    available.find((entry) => !entry.unavailable) ??
    available[0];
  if (!fallback) throw new Error("AgentLink has no connected Claude or Codex accounts");
  const selected = available.some((entry) => entry.id === currentModelId) ? currentModelId : fallback.id;
  return {
    currentModelId: selected,
    availableModels: available.map((entry) => ({
      modelId: entry.id,
      name: `${entry.modelLabel} · ${entry.email}`,
      description: entry.kind === "router"
        ? "Automatic route · chooses a configured work type, model and healthy account for this turn"
        : entry.kind === "paseo-acp"
        ? `${entry.email} · connected Paseo provider${entry.providerDescription ? ` · ${entry.providerDescription}` : ""}`
        : `${entry.provider === "claude" ? "Claude Code" : "Codex"} · ${entry.primary ? "primary sign-in" : "connected sign-in"}${entry.unavailable ? ` · unavailable: ${entry.unavailable}` : " · available"}`,
    })),
  };
}

function resolveProfile(modelId) {
  return profiles().find((entry) => entry.id === modelId) ?? null;
}

function backendKey(profile) {
  return profile.kind === "paseo-acp" ? `paseo:${profile.providerId}` : `${profile.provider}:${profile.accountKey}`;
}

function normalizedRouterTarget(value) {
  if (!value || typeof value !== "object" || typeof value.model !== "string" || !value.model) return null;
  let provider = typeof value.provider === "string" ? value.provider : "";
  let account = typeof value.account === "string" && value.account ? value.account : "provider";
  if (provider === "claude-auto" || provider === "codex-auto") {
    provider = provider.slice(0, -5);
    account = "auto";
  }
  if (!provider) return null;
  if ((provider === "claude" || provider === "codex") && account === "provider") account = "auto";
  const mode = typeof value.mode === "string" && ROUTER_MODE_IDS.has(value.mode) ? value.mode : "inherit";
  return { provider, account, model: value.model, mode };
}

function normalizedRouterSkills(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))].slice(0, 24);
}

function routerConfig() {
  const raw = readJson(ROUTER_CONFIG);
  const groups = (Array.isArray(raw?.targetGroups) ? raw.targetGroups : ROUTER_DEFAULT_GROUPS).flatMap((value) => {
    if (!value || typeof value !== "object" || typeof value.name !== "string" || !Array.isArray(value.targets)) return [];
    const targets = value.targets.map(normalizedRouterTarget).filter(Boolean);
    if (targets.length === 0) return [];
    return [{
      name: value.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "work",
      purpose: typeof value.purpose === "string" ? value.purpose : "Configured work",
      skills: normalizedRouterSkills(value.skills),
      instructions: typeof value.instructions === "string" ? value.instructions.slice(0, 6_000) : "",
      targets,
    }];
  });
  let rules = "";
  try {
    rules = readFileSync(ROUTER_RULES, "utf8").slice(0, 12_000);
  } catch {
    // Optional user rules.
  }
  return { groups: groups.length > 0 ? groups : ROUTER_DEFAULT_GROUPS, rules };
}

function routeWords(value) {
  return new Set(String(value).toLowerCase().match(/[a-z0-9][a-z0-9.+-]*/g) ?? []);
}

function routerGroup(text, config) {
  const lower = text.toLowerCase();
  const explicitlyNamed = config.groups.find((group) =>
    lower.includes(`route:${group.name}`) || lower.includes(`route ${group.name}`) || lower.includes(`@${group.name}`),
  );
  if (explicitlyNamed) return explicitlyNamed;
  const categoryMatchers = [
    ["browser", /\b(browser|chrome|website|page|visual|screenshot|e2e|qa|walkthrough)\b/i],
    ["build", /\b(build|implement|code|fix|debug|refactor|migrat|patch|test|ship|release|deploy|edit|change)\w*\b/i],
    ["judgment", /\b(review|audit|architecture|design|ux|ui|assess|critique|security|compliance)\w*\b/i],
    ["planning", /\b(plan|strategy|spec|proposal|roadmap|approach|research)\w*\b/i],
    ["fast", /\b(explain|summar|rewrite|format|translate|quick|small|tiny)\w*\b/i],
  ];
  for (const [name, matcher] of categoryMatchers) {
    if (matcher.test(text)) {
      const match = config.groups.find((group) => group.name === name);
      if (match) return match;
    }
  }
  const words = routeWords(text);
  let best = null;
  let bestScore = 0;
  for (const group of config.groups) {
    const candidates = routeWords(`${group.name} ${group.purpose}`);
    let score = 0;
    for (const word of candidates) if (word.length > 3 && words.has(word)) score += 1;
    if (score > bestScore) {
      best = group;
      bestScore = score;
    }
  }
  return best ?? config.groups.find((group) => group.name === "fast") ?? config.groups[0];
}

function accountPreferenceRank(provider, accountKey) {
  for (const [name, rank] of [["first", 0], ["last", 2]]) {
    try {
      if (readFileSync(join(ROOT, "state", `prefer-${provider}-${name}`), "utf8").split(/\r?\n/).includes(accountKey)) return rank;
    } catch {
      // No preference file.
    }
  }
  return 1;
}

function accountLastUsed(provider, accountKey) {
  try {
    return Number.parseInt(readFileSync(join(POOLS, `last-${provider}-${accountKey}`), "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function routeProfilesForTarget(target) {
  const available = profiles().filter((profile) => profile.kind !== "router" && profile.model === target.model);
  if (target.provider !== "claude" && target.provider !== "codex") {
    return available.filter((profile) => profile.kind === "paseo-acp" && profile.providerId === target.provider);
  }
  let candidates = available.filter((profile) => profile.provider === target.provider && profile.kind !== "paseo-acp");
  if (target.account !== "auto") {
    candidates = candidates.filter((profile) =>
      (target.account === "primary" && profile.primary) ||
      profile.accountKey === target.account ||
      profile.email.toLowerCase() === target.account.toLowerCase(),
    );
  }
  return candidates.sort((left, right) =>
    accountPreferenceRank(left.provider, left.accountKey) - accountPreferenceRank(right.provider, right.accountKey) ||
    accountLastUsed(left.provider, left.accountKey) - accountLastUsed(right.provider, right.accountKey),
  );
}

function explicitRouteProfile(text) {
  const lower = text.toLowerCase();
  return profiles().find((profile) =>
    profile.kind !== "router" &&
    (lower.includes(profile.model.toLowerCase()) || lower.includes(profile.modelLabel.toLowerCase())) &&
    (profile.kind === "paseo-acp" || lower.includes(profile.email.toLowerCase())),
  ) ?? null;
}

function automaticRoute(text) {
  const config = routerConfig();
  const explicit = explicitRouteProfile(text);
  if (explicit) return { group: "explicit", candidates: [{ profile: explicit, mode: "inherit" }], skills: [], instructions: "", rules: config.rules };
  const group = routerGroup(text, config);
  const candidates = [];
  const seen = new Set();
  for (const target of group.targets) {
    for (const profile of routeProfilesForTarget(target)) {
      if (seen.has(profile.id) || heldReason(profile.provider, profile.accountKey, profile.model)) continue;
      seen.add(profile.id);
      candidates.push({ profile, mode: target.mode });
    }
  }
  return { group: group.name, candidates, skills: group.skills, instructions: group.instructions, rules: config.rules };
}

function routeMode(sessionMode, targetMode) {
  return targetMode === "inherit" || !ROUTER_MODE_IDS.has(targetMode) ? sessionMode : targetMode;
}

function modeLabel(modeId) {
  return MODES.availableModes.find((mode) => mode.id === modeId)?.name ?? modeId;
}

let skillCatalog = null;

function installedSkills(refresh = false) {
  if (skillCatalog && !refresh) return skillCatalog;
  const catalog = new Map();
  const visited = new Set();
  let scanned = 0;
  const visit = (directory, depth) => {
    if (depth > 6 || scanned >= 2_000) return;
    let real;
    try {
      real = realpathSync(directory);
      if (visited.has(real) || !statSync(real).isDirectory()) return;
      visited.add(real);
    } catch {
      return;
    }
    let entries;
    try {
      entries = readdirSync(real, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned++ >= 2_000) break;
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const path = join(real, entry.name);
      if (entry.name === "SKILL.md") {
        let name = basename(dirname(path));
        try {
          const header = readFileSync(path, "utf8").slice(0, 2_000);
          name = header.match(/^name:\s*["']?([^\n"']+)/m)?.[1]?.trim() || name;
        } catch {
          // The selected provider will report an unreadable skill if configured.
        }
        for (const key of [name, basename(dirname(path))]) if (!catalog.has(key.toLowerCase())) catalog.set(key.toLowerCase(), path);
        continue;
      }
      try {
        if (entry.isDirectory() || statSync(path).isDirectory()) visit(path, depth + 1);
      } catch {
        // Ignore broken skill links.
      }
    }
  };
  for (const root of [join(HOME, ".agents", "skills"), join(HOME, ".codex", "skills"), join(HOME, ".claude", "skills")]) visit(root, 0);
  skillCatalog = catalog;
  return catalog;
}

function resolveRouteSkills(configured) {
  const paths = [];
  const missing = [];
  const catalog = installedSkills();
  for (const requested of configured ?? []) {
    let path = "";
    if (requested.includes("/")) {
      const candidate = resolve(requested.startsWith("/") ? requested : join(HOME, requested));
      const skillFile = basename(candidate) === "SKILL.md" ? candidate : join(candidate, "SKILL.md");
      try {
        const real = realpathSync(skillFile);
        if ((real === HOME || real.startsWith(`${HOME}/`)) && statSync(real).isFile()) path = real;
      } catch {
        // Report the configured value below.
      }
    } else {
      path = catalog.get(requested.toLowerCase()) ?? "";
      if (!path) path = installedSkills(true).get(requested.toLowerCase()) ?? "";
    }
    if (path) paths.push({ name: requested, path });
    else missing.push(requested);
  }
  if (missing.length > 0) throw new Error(`Required AgentRouter skill${missing.length === 1 ? "" : "s"} not installed: ${missing.join(", ")}`);
  return paths;
}

function titleFrom(text) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 72 ? `${line.slice(0, 69)}…` : line || "AgentLink chat";
}

function promptText(blocks, sessionId) {
  const text = [];
  const images = [];
  let imageIndex = 0;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
    else if (block?.type === "resource" && typeof block.resource?.text === "string") {
      text.push(`\n[Context: ${block.resource.uri ?? "embedded resource"}]\n${block.resource.text}`);
    } else if (block?.type === "resource_link") {
      text.push(`\n[Referenced resource: ${block.name ?? block.uri ?? "resource"}${block.uri ? ` · ${block.uri}` : ""}]`);
    } else if (block?.type === "image" && typeof block.data === "string") {
      const mime = typeof block.mimeType === "string" ? block.mimeType : "image/png";
      const extension = mime.includes("jpeg") ? "jpg" : mime.includes("gif") ? "gif" : mime.includes("webp") ? "webp" : "png";
      const directory = join(ATTACHMENT_ROOT, sessionId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${Date.now()}-${imageIndex++}.${extension}`);
      writeFileSync(path, Buffer.from(block.data, "base64"), { mode: 0o600 });
      images.push(path);
      text.push(`\n[Attached image: ${path}]`);
    }
  }
  return { text: text.join("\n").trim(), images };
}

function transcriptLine(entry) {
  const role = entry.role === "assistant" ? `Assistant (${entry.profile ?? "AgentLink"})` : "User";
  return `${role}:\n${entry.text}`;
}

function bridgePrompt(session, backend, currentText) {
  const beforeCurrent = session.transcript.slice(0, -1);
  const start = Number.isInteger(backend?.syncedThrough) ? backend.syncedThrough : 0;
  const missed = beforeCurrent.slice(Math.max(0, start));
  if (missed.length === 0 && backend?.sessionId) return currentText;

  const full = missed.map(transcriptLine).join("\n\n");
  let context = full;
  if (context.length > CONTEXT_LIMIT) {
    const older = missed.slice(0, -12);
    const recent = missed.slice(-12).map(transcriptLine).join("\n\n");
    const index = older
      .map((entry) => `${entry.role === "assistant" ? "A" : "U"}: ${entry.text.replace(/\s+/g, " ").slice(0, 260)}`)
      .join("\n")
      .slice(-12_000);
    context = `[Earlier transcript index]\n${index}\n\n[Recent transcript]\n${recent}`;
    if (context.length > CONTEXT_LIMIT) context = context.slice(-CONTEXT_LIMIT);
  }
  return [
    "[AgentLink runtime contract]",
    "This is one logical Paseo chat. The composer model picker changes only the model/account/provider that owns the next turn; it never creates a replacement chat, continuation tab, archive, or terminal window.",
    "When delegation is useful, read ~/.agents/skills/paseo/SKILL.md completely, call Paseo list_profiles, then use Paseo create_agent (or its agent-scoped CLI equivalent if tools are unavailable). Omit workspaceId so the child stays attached to this parent in the current workspace. Never use provider-native subagents as the default inside Paseo.",
    "Use the installed paseo-handoff, paseo-advisor, or paseo-committee skill only when the user's intent matches it. Never create a workspace merely to delegate, retry, continue, investigate, or switch model/provider/account; create an isolated workspace only when explicitly requested or divergent repository state genuinely requires it. Keep small work here and use at most three concurrent subagents unless the user asks for more.",
    "Preserve completed work, decisions, child history, and live child-agent ownership. Provider or account exhaustion must fail in this chat and wait for another picker choice; never detach, archive, replace, rotate, move, or reparent a child behind the user's back.",
    "Treat the context below as prior conversation and answer only the current request.",
    context,
    "[Current user request]",
    currentText,
  ].filter(Boolean).join("\n\n");
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let parentRequestSequence = 0;
const parentRequests = new Map();

function requestParent(method, params) {
  const id = `agentlink:${process.pid}:${++parentRequestSequence}`;
  const pending = new Promise((resolvePromise, reject) => parentRequests.set(id, { resolve: resolvePromise, reject }));
  send({ jsonrpc: "2.0", id, method, params });
  return pending;
}

function acceptParentResponse(message) {
  const pending = parentRequests.get(message.id);
  if (!pending) return false;
  parentRequests.delete(message.id);
  if (message.error) pending.reject(new Error(message.error.message ?? "Paseo client request failed"));
  else pending.resolve(message.result);
  return true;
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function update(sessionId, payload) {
  notify("session/update", { sessionId, update: payload });
}

function emitText(sessionId, text, thought = false) {
  if (!text) return;
  update(sessionId, {
    sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
    content: { type: "text", text },
  });
}

function toolKind(name) {
  const value = String(name ?? "").toLowerCase();
  if (/read|cat|view/.test(value)) return "read";
  if (/edit|write|patch|notebook/.test(value)) return "edit";
  if (/delete|remove/.test(value)) return "delete";
  if (/search|grep|glob|find/.test(value)) return "search";
  if (/web|fetch|browse/.test(value)) return "fetch";
  if (/bash|shell|command|exec|terminal/.test(value)) return "execute";
  if (/think|reason/.test(value)) return "think";
  return "other";
}

function locationsFrom(input) {
  if (!input || typeof input !== "object") return undefined;
  const values = [input.path, input.file_path, input.filePath, input.notebook_path]
    .filter((value) => typeof value === "string")
    .map((path) => ({ path }));
  return values.length ? values : undefined;
}

function findBinary(name) {
  const candidates = [];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory || resolve(directory) === resolve(join(ROOT, "bin"))) continue;
    candidates.push(join(directory, name));
  }
  candidates.push(join(HOME, ".local", "bin", name), join(HOME, ".npm-global", "bin", name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`);
  for (const path of candidates) {
    try {
      if (existsSync(path) && statSync(path).isFile()) return path;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`${name} is not installed`);
}

const FORWARDED_CLIENT_METHODS = new Set([
  "session/request_permission",
  "fs/read_text_file",
  "fs/write_text_file",
  "terminal/create",
  "terminal/output",
  "terminal/wait_for_exit",
  "terminal/kill",
  "terminal/release",
]);

class NestedACPConnection {
  constructor(definition, options = {}) {
    this.definition = definition;
    this.outerSessionId = options.outerSessionId ?? null;
    this.cwd = options.cwd ?? HOME;
    this.probe = options.probe === true;
    this.onUpdate = options.onUpdate ?? null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.child = null;
    this.childSessionId = null;
    this.initializeResult = null;
    this.closed = false;
  }

  async start() {
    const [command, ...args] = this.definition.command;
    const binary = command.includes("/") ? resolve(command) : findBinary(command);
    if (!existsSync(binary)) throw new Error(`${this.definition.label} command was not found: ${binary}`);
    this.child = spawn(binary, args, {
      // ACP receives the real workspace in session/new. Keeping the transport
      // process at / prevents CLIs such as Kimi from recursively watching the
      // user's entire home before that session exists.
      cwd: "/",
      env: { ...process.env, ...this.definition.env, NO_BROWSER: "true", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    let remainder = "";
    this.child.stdout.on("data", (chunk) => {
      remainder += chunk;
      const lines = remainder.split(/\r?\n/);
      remainder = lines.pop() ?? "";
      for (const line of lines) this.acceptLine(line);
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-32_000);
    });
    this.child.on("error", (error) => this.failPending(error));
    this.child.on("close", (code, signal) => {
      if (remainder.trim()) this.acceptLine(remainder);
      this.closed = true;
      this.failPending(new Error(`${this.definition.label} ACP exited (${code ?? "null"}${signal ? `, ${signal}` : ""})${this.stderr.trim() ? `: ${this.stderr.trim().slice(-2000)}` : ""}`));
    });
    this.initializeResult = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { ...parentClientCapabilities, ...(this.definition.clientCapabilities ?? {}) },
      clientInfo: { name: "AgentLink", version: VERSION },
    });
    return this.initializeResult;
  }

  acceptLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      void this.handleClientRequest(message);
      return;
    }
    if (message.method === "session/update") {
      if (this.outerSessionId && message.params?.update) this.onUpdate?.(message.params.update);
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? `${this.definition.label} ACP request failed`));
    else pending.resolve(message.result);
  }

  async handleClientRequest(message) {
    if (this.probe) {
      const result = message.method === "session/request_permission" ? { outcome: { outcome: "cancelled" } } : null;
      this.send({ jsonrpc: "2.0", id: message.id, ...(result ? { result } : { error: { code: -32601, message: `Probe does not support ${message.method}` } }) });
      return;
    }
    if (!FORWARDED_CLIENT_METHODS.has(message.method)) {
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported nested ACP client method: ${message.method}` } });
      return;
    }
    const params = message.params && typeof message.params === "object" ? { ...message.params } : {};
    if (this.outerSessionId && "sessionId" in params) params.sessionId = this.outerSessionId;
    try {
      const result = await requestParent(message.method, params);
      this.send({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    }
  }

  send(message) {
    if (!this.child?.stdin.writable) throw new Error(`${this.definition.label} ACP is not writable`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error(`${this.definition.label} ACP is closed`));
    const id = this.nextId++;
    const result = new Promise((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject }));
    this.send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  notify(method, params = {}) {
    if (!this.closed) this.send({ jsonrpc: "2.0", method, params });
  }

  failPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async close() {
    if (!this.child) return;
    if (!this.closed && this.childSessionId) {
      await Promise.race([
        this.request("session/close", { sessionId: this.childSessionId }).catch(() => undefined),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 500)),
      ]);
    }
    const child = this.child;
    this.closed = true;
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      // Already stopped.
    }
    this.failPending(new Error(`${this.definition.label} ACP closed`));
  }
}

function childEnvironment(profile) {
  const env = { ...process.env, NO_COLOR: "1", TERM: "dumb", AGENT_LINK_ACCOUNT: profile.email };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  if (profile.provider === "claude" && !profile.primary) env.CLAUDE_CONFIG_DIR = profile.configDir;
  if (profile.provider === "codex" && !profile.primary) env.CODEX_HOME = profile.configDir;
  return env;
}

function genericConnectionKey(sessionId, providerId) {
  return `${sessionId}:${providerId}`;
}

function genericDefinition(profile) {
  return {
    id: profile.providerId,
    label: profile.email,
    command: profile.command,
    env: profile.providerEnv ?? {},
    clientCapabilities: profile.clientCapabilities ?? {},
  };
}

function turnUpdate(state, payload) {
  state.activity = true;
  if (payload?.sessionUpdate === "tool_call" || payload?.sessionUpdate === "tool_call_update") state.toolActivity = true;
  if (state.buffer) state.buffer.push(payload);
  else update(state.sessionId, payload);
}

function turnText(state, text, thought = false) {
  if (!text) return;
  turnUpdate(state, {
    sessionUpdate: thought ? "agent_thought_chunk" : "agent_message_chunk",
    content: { type: "text", text },
  });
}

function flushTurn(state) {
  for (const payload of state.buffer ?? []) update(state.sessionId, payload);
  state.buffer = null;
}

function genericTurnUpdate(state, payload) {
  if (["session_info_update", "current_mode_update", "config_option_update"].includes(payload?.sessionUpdate)) return;
  if (payload?.sessionUpdate === "agent_message_chunk" && payload.content?.type === "text") {
    state.text += payload.content.text ?? "";
  }
  turnUpdate(state, payload);
}

function genericModeId(modes, currentModeId, requestedMode, profile) {
  const normalized = modes.map((mode) => ({
    ...mode,
    search: `${mode.id ?? ""} ${mode.name ?? ""}`.toLowerCase(),
  }));
  const matcher = requestedMode === "plan"
    ? /(^|\W)(plan|read[ -]?only)(\W|$)/
    : requestedMode === "full-access"
      ? /(^|\W)(full[ -]?access|allow[ -]?all|bypass|yolo|unrestricted|danger)(\W|$)/
      : /(^|\W)(auto|default|agent|build)(\W|$)/;
  const exact = normalized.find((mode) => mode.id === requestedMode || (requestedMode === "full-access" && mode.id === "full"));
  const matched = exact ?? normalized.find((mode) => matcher.test(mode.search));
  if (matched?.id) return matched.id;
  if (requestedMode === "auto") return currentModeId ?? null;
  throw new Error(`${profile.email} does not expose a compatible ${modeLabel(requestedMode)} mode`);
}

async function ensureGenericBackend(session, profile, backend, state, requestedMode) {
  const key = genericConnectionKey(session.id, profile.providerId);
  let connection = genericConnections.get(key);
  if (connection?.closed) {
    genericConnections.delete(key);
    connection = null;
  }
  if (!connection) {
    connection = new NestedACPConnection(genericDefinition(profile), {
      outerSessionId: session.id,
      cwd: session.cwd,
    });
    await connection.start();
    genericConnections.set(key, connection);
  }
  connection.onUpdate = null;
  const mcpServers = sessionContexts.get(session.id)?.mcpServers ?? [];
  let response = connection.sessionState ?? null;
  if (!connection.childSessionId && backend.sessionId) {
    try {
      if (connection.initializeResult?.agentCapabilities?.loadSession) {
        response = await connection.request("session/load", { sessionId: backend.sessionId, cwd: session.cwd, mcpServers });
      } else if (connection.initializeResult?.agentCapabilities?.sessionCapabilities?.resume) {
        response = await connection.request("session/resume", { sessionId: backend.sessionId, cwd: session.cwd, mcpServers });
      } else {
        backend.sessionId = null;
      }
      if (backend.sessionId) connection.childSessionId = backend.sessionId;
    } catch {
      backend.sessionId = null;
      connection.childSessionId = null;
    }
  }
  if (!connection.childSessionId) {
    response = await connection.request("session/new", { cwd: session.cwd, mcpServers });
    if (!response?.sessionId) throw new Error(`${profile.email} did not return an ACP session ID`);
    backend.sessionId = response.sessionId;
    connection.childSessionId = response.sessionId;
  }
  connection.sessionState = response;
  const currentModelId = connection.currentModelId ?? response?.models?.currentModelId;
  if (currentModelId !== profile.model) {
    const configOptions = Array.isArray(response?.configOptions) ? response.configOptions : [];
    const modelOption = configOptions.find((option) => option?.category === "model" || option?.id === "model");
    if (modelOption?.id) {
      const updated = await connection.request("session/set_config_option", {
        sessionId: connection.childSessionId,
        configId: modelOption.id,
        value: profile.model,
      });
      if (Array.isArray(updated?.configOptions)) response = { ...response, configOptions: updated.configOptions };
    } else {
      await connection.request("session/set_model", { sessionId: connection.childSessionId, modelId: profile.model });
    }
    connection.currentModelId = profile.model;
  }
  const modes = Array.isArray(response?.modes?.availableModes) ? response.modes.availableModes : [];
  const currentModeId = connection.currentModeId ?? response?.modes?.currentModeId;
  const desiredModeId = genericModeId(modes, currentModeId, requestedMode, profile);
  if (desiredModeId && desiredModeId !== currentModeId) {
    await connection.request("session/set_mode", { sessionId: connection.childSessionId, modeId: desiredModeId });
  }
  connection.currentModeId = desiredModeId;
  connection.onUpdate = (payload) => genericTurnUpdate(state, payload);
  return connection;
}

async function closeGenericConnections(sessionId) {
  const prefix = `${sessionId}:`;
  const closing = [];
  for (const [key, connection] of genericConnections) {
    if (!key.startsWith(prefix)) continue;
    genericConnections.delete(key);
    closing.push(connection.close());
  }
  await Promise.allSettled(closing);
}

function trustClaudeWorkspace(profile, cwd) {
  const path = profile.primary ? join(HOME, ".claude.json") : join(profile.configDir, ".claude.json");
  const config = readJson(path);
  if (!config) return;
  config.projects ||= {};
  config.projects[cwd] ||= {};
  if (config.projects[cwd].hasTrustDialogAccepted === true) return;
  config.projects[cwd].hasTrustDialogAccepted = true;
  atomicJson(path, config);
}

function spawnTurn(binary, args, options, input, onLine) {
  return new Promise((resolvePromise) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    options.running.child = child;
    let stderr = "";
    let stdoutRemainder = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutRemainder += chunk;
      const lines = stdoutRemainder.split(/\r?\n/);
      stdoutRemainder = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32_000);
    });
    child.on("error", (error) => resolvePromise({ code: -1, signal: null, stderr: `${stderr}\n${error.message}`.trim() }));
    child.on("close", (code, signal) => {
      if (stdoutRemainder.trim()) onLine(stdoutRemainder);
      resolvePromise({ code: code ?? -1, signal, stderr: stderr.trim() });
    });
    child.stdin.end(input);
  });
}

function claudeArgs(profile, backend, mode) {
  const permissionMode = mode === "plan" ? "plan" : mode === "full-access" ? "bypassPermissions" : "auto";
  const args = [
    "-p",
    "--input-format", "text",
    "--output-format", "stream-json",
    "--verbose",
    "--forward-subagent-text",
    "--model", profile.model,
    "--permission-mode", permissionMode,
  ];
  if (backend.sessionId) args.push("--resume", backend.sessionId);
  else {
    backend.sessionId = randomUUID();
    args.push("--session-id", backend.sessionId);
  }
  return args;
}

function codexModeArgs(mode) {
  if (mode === "plan") return ["-s", "read-only"];
  if (mode === "full-access") return ["--dangerously-bypass-approvals-and-sandbox"];
  return ["--approve-for-me"];
}

function codexArgs(profile, backend, session, images, mode) {
  const modeArgs = codexModeArgs(mode);
  if (backend.sessionId) {
    const args = ["exec", ...modeArgs, "resume", backend.sessionId, "--json", "--skip-git-repo-check", "-m", profile.model];
    for (const image of images) args.push("-i", image);
    args.push("-");
    return args;
  }
  const args = [
    "exec", ...modeArgs, "--json", "--skip-git-repo-check", "-C", session.cwd, "-m", profile.model,
  ];
  for (const image of images) args.push("-i", image);
  args.push("-");
  return args;
}

function parseClaudeLine(line, state) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message.session_id === "string") state.backend.sessionId = message.session_id;
  if (message.type === "assistant") {
    for (const block of message.message?.content ?? []) {
      if (block.type === "text") {
        state.text += block.text ?? "";
        turnText(state, block.text ?? "");
      } else if (block.type === "thinking") {
        turnText(state, block.thinking ?? "", true);
      } else if (block.type === "tool_use") {
        const id = block.id ?? randomUUID();
        state.tools.add(id);
        turnUpdate(state, {
          sessionUpdate: "tool_call",
          toolCallId: id,
          title: block.name ?? "Claude tool",
          kind: toolKind(block.name),
          status: "in_progress",
          rawInput: block.input,
          ...(locationsFrom(block.input) ? { locations: locationsFrom(block.input) } : {}),
        });
      }
    }
  } else if (message.type === "user") {
    for (const block of message.message?.content ?? []) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      turnUpdate(state, {
        sessionUpdate: "tool_call_update",
        toolCallId: block.tool_use_id,
        status: block.is_error ? "failed" : "completed",
        rawOutput: block.content,
        content: [{ type: "content", content: { type: "text", text: content.slice(0, 24_000) } }],
      });
      state.tools.delete(block.tool_use_id);
    }
  } else if (message.type === "result") {
    if (message.is_error) state.providerError = String(message.result ?? message.error ?? "Claude turn failed");
    if (!state.text && typeof message.result === "string") {
      state.text = message.result;
      turnText(state, message.result);
    }
  }
}

function codexToolTitle(item) {
  if (item.type === "command_execution") return item.command ?? "Run command";
  if (item.type === "file_change") return "Change files";
  if (item.type === "mcp_tool_call") return `${item.server ?? "MCP"}: ${item.tool ?? "tool"}`;
  if (item.type === "web_search") return item.query ? `Search: ${item.query}` : "Web search";
  return item.type ?? "Codex tool";
}

function parseCodexLine(line, state) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.type === "thread.started" && typeof event.thread_id === "string") state.backend.sessionId = event.thread_id;
  if (event.type === "error" || event.type === "turn.failed") {
    state.providerError = String(event.message ?? event.error?.message ?? event.error ?? "Codex turn failed");
    return;
  }
  const item = event.item;
  if (!item) return;
  if (item.type === "agent_message" && event.type === "item.completed") {
    const text = item.text ?? item.content ?? "";
    if (typeof text === "string") {
      state.text += text;
      turnText(state, text);
    }
    return;
  }
  if (item.type === "reasoning" && event.type === "item.completed") {
    const text = item.text ?? item.summary ?? "";
    if (typeof text === "string") turnText(state, text, true);
    return;
  }
  const isTool = ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type);
  if (!isTool) return;
  const id = item.id ?? createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 20);
  if (event.type === "item.started") {
    state.tools.add(id);
    turnUpdate(state, {
      sessionUpdate: "tool_call",
      toolCallId: id,
      title: codexToolTitle(item),
      kind: item.type === "file_change" ? "edit" : item.type === "web_search" ? "fetch" : "execute",
      status: "in_progress",
      rawInput: item,
    });
  } else if (event.type === "item.completed") {
    if (!state.tools.has(id)) {
      turnUpdate(state, {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: codexToolTitle(item),
        kind: item.type === "file_change" ? "edit" : item.type === "web_search" ? "fetch" : "execute",
        status: "in_progress",
        rawInput: item,
      });
    }
    turnUpdate(state, {
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      status: item.status === "failed" ? "failed" : "completed",
      rawOutput: item,
    });
    state.tools.delete(id);
  }
}

function conciseProviderError(profile, result, state) {
  const combined = [state.providerError, result.stderr].filter(Boolean).join("\n").trim();
  const lines = combined.split(/\r?\n/).filter((line) => line.trim() && !/could not create PATH aliases/i.test(line));
  const detail = lines.slice(-6).join("\n").slice(-4000) || `${profile.provider} exited with code ${result.code}`;
  return `${profile.modelLabel} · ${profile.email} could not serve this turn. The AgentLink chat and history are unchanged.\n\n${detail}`;
}

async function executeProfileTurn(session, request, parsed, selected, currentText, running, buffered, requestedMode) {
  const key = backendKey(selected);
  const backend = session.backends[key] ?? { provider: selected.provider, accountKey: selected.accountKey, sessionId: null, syncedThrough: 0 };
  session.backends[key] = backend;
  const input = bridgePrompt(session, backend, currentText);
  running.child = null;
  running.cancel = null;
  const state = {
    sessionId: session.id,
    backend,
    text: "",
    providerError: "",
    tools: new Set(),
    activity: false,
    toolActivity: false,
    buffer: buffered ? [] : null,
  };
  let result;
  try {
    if (selected.kind === "paseo-acp") {
      const connection = await ensureGenericBackend(session, selected, backend, state, requestedMode);
      running.cancel = () => connection.notify("session/cancel", { sessionId: connection.childSessionId });
      const childPrompt = [
        { type: "text", text: input },
        ...(Array.isArray(request.prompt) ? request.prompt.filter((block) => block?.type === "image") : []),
      ];
      let response;
      try {
        response = await connection.request("session/prompt", { sessionId: connection.childSessionId, prompt: childPrompt });
      } finally {
        connection.onUpdate = null;
      }
      state.stopReason = response?.stopReason ?? "end_turn";
      result = { code: 0, signal: null, stderr: "" };
    } else if (selected.provider === "claude") {
      trustClaudeWorkspace(selected, session.cwd);
      result = await spawnTurn(
        findBinary("claude"),
        claudeArgs(selected, backend, requestedMode),
        { cwd: session.cwd, env: childEnvironment(selected), running },
        input,
        (line) => parseClaudeLine(line, state),
      );
    } else {
      result = await spawnTurn(
        findBinary("codex"),
        codexArgs(selected, backend, session, parsed.images, requestedMode),
        { cwd: session.cwd, env: childEnvironment(selected), running },
        input,
        (line) => parseCodexLine(line, state),
      );
    }
  } catch (error) {
    result = { code: -1, signal: null, stderr: error instanceof Error ? error.message : String(error) };
  }
  for (const toolCallId of state.tools) {
    turnUpdate(state, { sessionUpdate: "tool_call_update", toolCallId, status: running.cancelled ? "failed" : "completed" });
  }
  return { backend, result, state };
}

function stampAutomaticAccount(profile) {
  if (profile.kind === "paseo-acp") return;
  try {
    mkdirSync(POOLS, { recursive: true, mode: 0o700 });
    writeFileSync(join(POOLS, `last-${profile.provider}-${profile.accountKey}`), `${Math.floor(Date.now() / 1000)}\n`, { mode: 0o600 });
  } catch {
    // Routing still works if optional recency evidence cannot be written.
  }
}

async function dropGenericConnection(sessionId, profile) {
  if (profile.kind !== "paseo-acp") return;
  const key = genericConnectionKey(sessionId, profile.providerId);
  const connection = genericConnections.get(key);
  if (!connection) return;
  genericConnections.delete(key);
  await connection.close().catch(() => undefined);
}

async function runPrompt(session, request) {
  const parsed = promptText(request.prompt, session.id);
  if (!parsed.text) {
    emitText(session.id, "AgentLink received an empty prompt.");
    return { stopReason: "refusal", ...(request.messageId ? { userMessageId: request.messageId } : {}) };
  }
  if (!session.title) {
    session.title = titleFrom(parsed.text);
    update(session.id, { sessionUpdate: "session_info_update", title: session.title, updatedAt: new Date().toISOString() });
  }
  session.transcript.push({ role: "user", text: parsed.text, at: new Date().toISOString() });
  saveSession(session);
  const refuse = (message, profile = "AgentLink") => {
    emitText(session.id, message);
    session.transcript.push({ role: "assistant", text: message, profile, at: new Date().toISOString() });
    saveSession(session);
    return { stopReason: "refusal", ...(request.messageId ? { userMessageId: request.messageId } : {}) };
  };
  const pickerSelection = resolveProfile(session.currentModelId);
  if (!pickerSelection) {
    return refuse("The selected AgentLink account/model no longer exists. Choose another entry in the model picker.");
  }
  const route = pickerSelection.kind === "router" ? automaticRoute(parsed.text) : null;
  let requiredSkills = [];
  if (route) {
    try {
      requiredSkills = resolveRouteSkills(route.skills);
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error), "AgentRouter · Automatic route");
    }
  }
  const candidates = route ? route.candidates : [{ profile: pickerSelection, mode: "inherit" }];
  if (candidates.length === 0) {
    return refuse(`AgentRouter found no available model/account in the '${route?.group ?? "configured"}' route. Update AgentLink → Orchestration or choose a specific model in this chat.`);
  }
  const running = { child: null, cancel: null, cancelled: false };
  activeTurns.set(session.id, running);
  const failures = [];
  let completed = null;
  try {
    for (const candidate of candidates) {
      const selected = candidate.profile;
      const requestedMode = routeMode(session.currentModeId, candidate.mode);
      const unavailable = heldReason(selected.provider, selected.accountKey, selected.model);
      if (unavailable) {
        failures.push(`${selected.modelLabel} · ${selected.email}: ${unavailable}`);
        continue;
      }
      if (route) {
        stampAutomaticAccount(selected);
        emitText(session.id, `AgentRouter: ${route.group} → ${selected.modelLabel} · ${selected.email} · ${modeLabel(requestedMode)}\n`, true);
      }
      const routedText = route
        ? [
            `[AgentRouter selected route: ${route.group}]`,
            "You are the selected answer model. Complete the user's request in this same AgentLink chat; do not delegate merely to change provider or account.",
            requiredSkills.length > 0
              ? `[Required skills]\nBefore acting, read each SKILL.md completely and follow it. If one cannot be read, stop before changing anything.\n${requiredSkills.map((skill) => `- ${skill.name}: ${skill.path}`).join("\n")}`
              : "",
            route.instructions ? `[Work-type instructions]\n${route.instructions}` : "",
            route.rules ? `[User orchestration rules]\n${route.rules}` : "",
            `[Current user request]\n${parsed.text}`,
          ].filter(Boolean).join("\n\n")
        : parsed.text;
      const attempt = await executeProfileTurn(session, request, parsed, selected, routedText, running, Boolean(route), requestedMode);
      if (running.cancelled) {
        flushTurn(attempt.state);
        saveSession(session);
        return { stopReason: "cancelled", ...(request.messageId ? { userMessageId: request.messageId } : {}) };
      }
      if (attempt.result.code === 0 && !attempt.state.providerError) {
        flushTurn(attempt.state);
        completed = { selected, requestedMode, ...attempt };
        break;
      }
      attempt.backend.sessionId = null;
      failures.push(conciseProviderError(selected, attempt.result, attempt.state));
      await dropGenericConnection(session.id, selected);
      if (!route || attempt.state.toolActivity) {
        flushTurn(attempt.state);
        completed = { selected, requestedMode, ...attempt, failed: true };
        break;
      }
    }
  } finally {
    activeTurns.delete(session.id);
  }
  if (!completed || completed.failed) {
    const detail = failures.map((failure, index) => `${index + 1}. ${failure}`).join("\n\n");
    return refuse(
      route
        ? `AgentRouter could not complete this turn. The same chat and history remain available.\n\n${detail}`
        : failures[0] ?? "The selected AgentLink profile could not serve this turn.",
      route ? "AgentRouter · Automatic route" : `${pickerSelection.modelLabel} · ${pickerSelection.email}`,
    );
  }
  const { selected, requestedMode, backend, state } = completed;
  if (running.cancelled) {
    saveSession(session);
    return { stopReason: "cancelled", ...(request.messageId ? { userMessageId: request.messageId } : {}) };
  }
  const answer = state.text.trim() || "Turn completed without a text response.";
  if (!state.text.trim()) emitText(session.id, answer);
  session.transcript.push({
    role: "assistant",
    text: answer,
    profile: route ? `AgentRouter → ${selected.modelLabel} · ${selected.email} · ${modeLabel(requestedMode)}` : `${selected.modelLabel} · ${selected.email}`,
    modelId: route ? ROUTER_PROFILE_ID : selected.id,
    at: new Date().toISOString(),
  });
  backend.syncedThrough = session.transcript.length;
  saveSession(session);
  return { stopReason: state.stopReason ?? "end_turn", ...(request.messageId ? { userMessageId: request.messageId } : {}) };
}

async function sessionResponse(session) {
  await ensureGenericCatalog();
  const models = modelsState(session.currentModelId);
  session.currentModelId = models.currentModelId;
  return { models, modes: { ...MODES, currentModeId: session.currentModeId } };
}

function replayHistory(session) {
  for (const entry of session.transcript) {
    update(session.id, {
      sessionUpdate: entry.role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
      content: { type: "text", text: entry.text },
    });
  }
}

async function newSession(params) {
  await ensureGenericCatalog();
  const id = randomUUID();
  const models = modelsState(null);
  const session = {
    version: 1,
    id,
    cwd: resolve(params.cwd),
    title: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentModelId: models.currentModelId,
    currentModeId: "auto",
    transcript: [],
    backends: {},
  };
  sessionContexts.set(id, { mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [] });
  saveSession(session);
  return { sessionId: id, ...(await sessionResponse(session)) };
}

function listSessions(params) {
  const rows = [];
  for (const name of readdirSync(SESSION_ROOT).filter((entry) => entry.endsWith(".json"))) {
    const session = readJson(join(SESSION_ROOT, name));
    // Paseo diagnostics create and close a zero-turn session while probing an
    // ACP. Keep its state loadable by ID, but never advertise it as history.
    if (!session?.id || !Array.isArray(session.transcript) || session.transcript.length === 0) continue;
    if (params.cwd && resolve(params.cwd) !== session.cwd) continue;
    rows.push({ sessionId: session.id, cwd: session.cwd, title: session.title || "AgentLink chat", updatedAt: session.updatedAt });
  }
  rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const offset = Math.max(0, Number.parseInt(params.cursor ?? "0", 10) || 0);
  const page = rows.slice(offset, offset + 200);
  return { sessions: page, ...(offset + page.length < rows.length ? { nextCursor: String(offset + page.length) } : {}) };
}

function cancelTurn(sessionId) {
  const running = activeTurns.get(sessionId);
  if (!running) return;
  running.cancelled = true;
  if (running.cancel) {
    try { running.cancel(); } catch { /* nested provider already stopped */ }
    return;
  }
  const child = running.child;
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }
  }, 3000).unref();
}

const activeTurns = new Map();

async function handleRequest(message) {
  const { id, method, params = {} } = message;
  if (method === "session/cancel") {
    cancelTurn(params.sessionId);
    return;
  }
  if (id === undefined) return;
  try {
    if (method === "initialize") {
      parentClientCapabilities = params.clientCapabilities && typeof params.clientCapabilities === "object" ? params.clientCapabilities : {};
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: "AgentLink", title: "AgentLink", version: VERSION },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
        authMethods: [],
      });
    } else if (method === "authenticate") {
      respond(id, {});
    } else if (method === "session/new") {
      respond(id, await newSession(params));
    } else if (method === "session/load") {
      const session = loadStoredSession(params.sessionId);
      session.cwd = resolve(params.cwd || session.cwd);
      sessionContexts.set(session.id, { mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [] });
      replayHistory(session);
      saveSession(session);
      respond(id, await sessionResponse(session));
    } else if (method === "session/resume") {
      const session = loadStoredSession(params.sessionId);
      session.cwd = resolve(params.cwd || session.cwd);
      sessionContexts.set(session.id, { mcpServers: Array.isArray(params.mcpServers) ? params.mcpServers : [] });
      saveSession(session);
      respond(id, await sessionResponse(session));
    } else if (method === "session/list") {
      respond(id, listSessions(params));
    } else if (method === "session/close") {
      cancelTurn(params.sessionId);
      await closeGenericConnections(params.sessionId);
      sessionContexts.delete(params.sessionId);
      respond(id, {});
    } else if (method === "session/set_model") {
      if (activeTurns.has(params.sessionId)) throw new Error("Wait for the current turn to stop before changing the AgentLink model");
      await ensureGenericCatalog();
      const session = loadStoredSession(params.sessionId);
      if (!resolveProfile(params.modelId)) throw new Error("That AgentLink account/model is no longer connected");
      session.currentModelId = params.modelId;
      saveSession(session);
      respond(id, {});
    } else if (method === "session/set_mode") {
      if (activeTurns.has(params.sessionId)) throw new Error("Wait for the current turn to stop before changing the AgentLink mode");
      const session = loadStoredSession(params.sessionId);
      if (!MODES.availableModes.some((mode) => mode.id === params.modeId)) throw new Error("Unsupported AgentLink mode");
      session.currentModeId = params.modeId;
      saveSession(session);
      respond(id, {});
    } else if (method === "session/prompt") {
      if (activeTurns.has(params.sessionId)) throw new Error("This AgentLink chat already has a turn running");
      const session = loadStoredSession(params.sessionId);
      respond(id, await runPrompt(session, params));
    } else {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    respondError(id, -32000, error instanceof Error ? error.message : String(error));
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    respondError(null, -32700, "Parse error");
    return;
  }
  if (message.method === undefined && message.id !== undefined && acceptParentResponse(message)) return;
  void handleRequest(message);
});

function shutdown() {
  for (const sessionId of activeTurns.keys()) cancelTurn(sessionId);
  for (const connection of genericConnections.values()) void connection.close();
  genericConnections.clear();
  for (const pending of parentRequests.values()) pending.reject(new Error("AgentLink stopped"));
  parentRequests.clear();
}

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
