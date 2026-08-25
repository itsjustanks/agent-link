import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { Destination } from "./contracts.shared";
import { onShutdown } from "./lifecycle.shared";
import {
  DIALECTS,
  backupFile,
  buildDestinations,
  destRead,
  destReadOne,
  dialectOf,
  envVarFor,
  jsonMcpRead,
  jsonSafeDef,
  maskValue,
  readJson,
  redactDetail,
  searchPath,
  tomlApply,
  tomlMcpNamesFromText,
  tomlMcpReadOneFromText,
  tomlReadForWrite,
  writeTextAtomic,
  TOML_SAFE_NAME,
  type McpDef,
} from "./handlers.server";
import type { Dialect, JsonIssue, LoginSession } from "./mcpjson.shared";

const HOME = homedir();

/** The stand-in the panel shows instead of a token. Never legal in a config. */
const MASK = "•••";

/** One MCP server as Claude-shaped JSON — the single shape everything speaks. */
type Entry = Record<string, unknown>;

/**
 * What is stored at one destination: the canonical view plus whatever the
 * canonical view cannot express. `carry` holds TOML lines this model cannot
 * render as JSON (an inline table, say). They are invisible to the editor and
 * written back untouched, so an edit can never delete a setting it never showed.
 */
type Stored = { entry: Entry; carry: string[] };

const COMMON_KEYS = new Set(["command", "args", "env", "url", "headers"]);

/** Keys that belong to one dialect family and have no word in another. */
const KEY_OWNERS: Record<string, Dialect[]> = {
  enabled: ["codex-toml", "grok-toml"],
};

const here = (): { line: number; column: number } => ({ line: 1, column: 1 });

/** Where a key sits in a JSON buffer, so an issue can point at it. */
function locate(text: string, key: string): { line: number; column: number } {
  const index = text.indexOf(`"${key}"`);
  if (index < 0) return here();
  const before = text.slice(0, index);
  return { line: before.split("\n").length, column: index - before.lastIndexOf("\n") };
}

// ------------------------------------------------------------------ TOML bridge

/**
 * A TOML scalar as a JSON value. Anything richer (inline table, mixed array)
 * returns undefined so the caller keeps the original line verbatim instead of
 * pretending to understand it.
 */
function tomlScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^[+-]?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^[+-]?\d*\.\d+$/.test(text)) return Number.parseFloat(text);
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return undefined;
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (inner === "") return [];
    const quoted = [...inner.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'/g)].map((match) => tomlScalar(match[0]));
    if (quoted.some((value) => typeof value !== "string")) return undefined;
    // A comma count that disagrees means something unquoted is in there, or a
    // string contains a comma — either way, do not risk a lossy reading.
    if (inner.split(",").filter((part) => part.trim() !== "").length !== quoted.length) return undefined;
    return quoted;
  }
  return undefined;
}

function tomlScalarText(value: unknown): string | null {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  }
  return null;
}

// ------------------------------------------------------------------ canonical read

function canonicaliseJson(raw: Entry): Entry {
  const entry: Entry = { ...raw };
  // A JSON config written with Codex's spelling still holds a real token. Read
  // it rather than reporting the server as credential-free — and write it back
  // under this dialect's own name, which is how such a file gets repaired.
  if (entry.http_headers && !entry.headers) entry.headers = entry.http_headers;
  delete entry.http_headers;
  delete entry.extra;
  delete entry.headerTable;
  return entry;
}

function tomlToCanonical(def: McpDef): Stored {
  const entry: Entry = {};
  if (def.command !== undefined) entry.command = def.command;
  if (def.args !== undefined) entry.args = def.args;
  if (def.url !== undefined) entry.url = def.url;
  if (def.env !== undefined) entry.env = def.env;
  if (def.headers !== undefined) entry.headers = def.headers;
  const carry: string[] = [];
  for (const line of def.extra ?? []) {
    const pair = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    const value = pair ? tomlScalar(pair[2]) : undefined;
    if (pair && value !== undefined) entry[pair[1]] = value;
    else carry.push(line);
  }
  return { entry, carry };
}

function readStored(dest: Destination, name: string): Stored | null {
  if (DIALECTS[dialectOf(dest)].format === "json-mcp") {
    const raw = jsonMcpRead(dest.configPath)[name] as Entry | undefined;
    return raw ? { entry: canonicaliseJson(raw), carry: [] } : null;
  }
  const def = destReadOne(dest, name);
  return def ? tomlToCanonical(def) : null;
}

// ------------------------------------------------------------------ masking

const SECRET_SECTIONS = ["env", "headers"] as const;

function recordAt(entry: Entry, section: string): Record<string, string> | null {
  const value = entry[section];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== "string") return null;
    record[key] = item;
  }
  return record;
}

/** Every place a secret is stored, as `section.key`. */
function secretPaths(entry: Entry): string[] {
  const paths: string[] = [];
  for (const section of SECRET_SECTIONS) {
    const record = recordAt(entry, section);
    for (const key of Object.keys(record ?? {})) paths.push(`${section}.${key}`);
  }
  return paths;
}

function maskEntry(entry: Entry): Entry {
  const masked: Entry = { ...entry };
  for (const section of SECRET_SECTIONS) {
    const record = recordAt(entry, section);
    if (!record) continue;
    masked[section] = Object.fromEntries(Object.entries(record).map(([key, value]) => [key, maskValue(value)]));
  }
  return masked;
}

function containsMask(value: unknown): boolean {
  if (typeof value === "string") return value.includes(MASK);
  if (Array.isArray(value)) return value.some(containsMask);
  if (value && typeof value === "object") return Object.values(value as Entry).some(containsMask);
  return false;
}

/**
 * A masked value stands for the secret at that exact key in that exact
 * destination — per-account tokens are the whole point of managing them here.
 * Anything still wearing the sentinel afterwards is unresolvable, and the write
 * is refused rather than writing ••• into a config or destroying the real value.
 */
function resolveMasks(entry: Entry, stored: Entry | null): { entry: Entry; unresolved: string[] } {
  const resolved: Entry = { ...entry };
  const unresolved: string[] = [];
  for (const section of SECRET_SECTIONS) {
    const incoming = recordAt(entry, section);
    if (!incoming) continue;
    const storedRecord = stored ? recordAt(stored, section) : null;
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (!value.includes(MASK)) {
        next[key] = value;
        continue;
      }
      const secret = storedRecord?.[key];
      if (typeof secret === "string") next[key] = secret;
      else unresolved.push(`${section}.${key}`);
    }
    resolved[section] = next;
  }
  for (const [key, value] of Object.entries(resolved)) {
    if (SECRET_SECTIONS.includes(key as (typeof SECRET_SECTIONS)[number])) continue;
    if (containsMask(value)) unresolved.push(key);
  }
  return { entry: resolved, unresolved };
}

// ------------------------------------------------------------------ placeholders

const PLACEHOLDERS: Array<[RegExp, string]> = [
  [/<[^<>\s]{2,60}>/, "an angle-bracket placeholder"],
  [/\$\{[^}]{1,60}\}/, "a ${…} placeholder"],
  [/\bchangeme\b/i, "'changeme'"],
  [/\bx{3,}\b/i, "'xxx'"],
  [/\byour[-_ ]?(token|key|secret|api)/i, "'your…' text"],
  [/\breplace[-_ ]?me\b/i, "'replace me'"],
];

/** Paths whose value still reads like something the user was meant to fill in. */
function placeholderPaths(entry: Entry, prefix = ""): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(entry)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      const hit = PLACEHOLDERS.find(([pattern]) => pattern.test(value));
      if (hit) found.push(`${path} looks like ${hit[1]}`);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item !== "string") return;
        const hit = PLACEHOLDERS.find(([pattern]) => pattern.test(item));
        if (hit) found.push(`${path}[${index}] looks like ${hit[1]}`);
      });
    } else if (value && typeof value === "object") {
      found.push(...placeholderPaths(value as Entry, path));
    }
  }
  return found;
}

// ------------------------------------------------------------------ dialect translation

type Native = { format: "json-mcp"; value: Entry } | { format: "toml-mcp"; def: McpDef };

/**
 * Translate the canonical entry into what this destination's language can hold.
 *
 * Two rules decide what survives. A key another dialect owns is dropped by name
 * — `enabled` means nothing to Claude, `type` means nothing to a TOML config —
 * so the caller can say so out loud. A key nobody owns survives if the target
 * can express it: TOML takes any scalar, and a JSON config takes a key it
 * already holds, which is what keeps a hand-added setting through an edit.
 */
function toNative(
  entry: Entry,
  carry: string[],
  dialect: Dialect,
  storedKeys: Set<string>,
): { native: Native; dropped: string[] } {
  const spec = DIALECTS[dialect];
  const dropped: string[] = [];
  const kept: Entry = {};

  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) continue;
    if (COMMON_KEYS.has(key)) {
      kept[key] = value;
      continue;
    }
    if (key === "type") {
      // Transport lives in the presence of url vs command in TOML; a `type`
      // line there is noise no CLI reads.
      if (spec.format === "json-mcp") kept.type = value;
      else dropped.push(`type has no equivalent in ${spec.label}`);
      continue;
    }
    const owners = KEY_OWNERS[key];
    if (owners && !owners.includes(dialect)) {
      dropped.push(`${key} has no equivalent in ${spec.label}`);
      continue;
    }
    if (spec.format === "toml-mcp") {
      if (tomlScalarText(value) === null) dropped.push(`${key} cannot be written as a TOML value`);
      else kept[key] = value;
      continue;
    }
    if (storedKeys.has(key)) kept[key] = value;
    else dropped.push(`${key} is not part of ${spec.label}'s JSON shape`);
  }

  if (spec.format === "json-mcp") {
    for (const line of carry) dropped.push(`${line.split("=")[0].trim()} is a TOML setting with no JSON equivalent`);
    // `writesType` only decides whether a missing one is invented. An explicit
    // type is JSON's own vocabulary, so it travels between JSON dialects rather
    // than being thrown away — dropping it would break an HTTP server outright.
    return { native: { format: "json-mcp", value: jsonSafeDef(kept as McpDef, spec.writesType ? "claude-json" : "other") as Entry }, dropped };
  }

  const def: McpDef = { headerTable: spec.headerKey };
  if (typeof kept.command === "string") def.command = kept.command;
  if (Array.isArray(kept.args)) def.args = kept.args as string[];
  if (typeof kept.url === "string") def.url = kept.url;
  const env = recordAt(kept, "env");
  const headers = recordAt(kept, "headers");
  if (env && Object.keys(env).length > 0) def.env = env;
  if (headers && Object.keys(headers).length > 0) def.headers = headers;
  const extra = [...carry];
  for (const [key, value] of Object.entries(kept)) {
    if (COMMON_KEYS.has(key)) continue;
    const text = tomlScalarText(value);
    if (text !== null) extra.push(`${key} = ${text}`);
  }
  if (extra.length > 0) def.extra = extra;
  return { native: { format: "toml-mcp", def }, dropped };
}

function renderNative(native: Native, name: string, configPath: string, headerKey: "headers" | "http_headers"): string {
  if (native.format === "json-mcp") return `${JSON.stringify({ mcpServers: { [name]: native.value } }, null, 2)}\n`;
  return `${tomlApply("", name, native.def, configPath, headerKey).trim()}\n`;
}

// ------------------------------------------------------------------ validation

const JSON_SAFE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_JSON_BYTES = 128 * 1024;

function validate(entry: Entry, name: string, dialect: Dialect, text: string): JsonIssue[] {
  const spec = DIALECTS[dialect];
  const issues: JsonIssue[] = [];
  const at = (key: string) => (text ? locate(text, key) : here());

  const nameOk = spec.format === "toml-mcp" ? TOML_SAFE_NAME.test(name) : JSON_SAFE_NAME.test(name);
  if (!nameOk) {
    issues.push({
      ...here(),
      code: "name-invalid",
      message:
        spec.format === "toml-mcp"
          ? `'${name}' is not a valid ${spec.label} table name — letters, numbers, - and _ only`
          : `'${name}' is not a usable server name — letters, numbers, . - and _ only`,
    });
  }

  const hasUrl = typeof entry.url === "string" && entry.url.trim() !== "";
  const hasCommand = typeof entry.command === "string" && entry.command.trim() !== "";
  if (hasUrl === hasCommand) {
    issues.push({
      ...at(hasUrl ? "url" : "command"),
      code: "shape",
      message: hasUrl ? "a server has either a url or a command, not both" : "a server needs a url (HTTP) or a command (stdio)",
    });
  }
  if ("url" in entry && !hasUrl) issues.push({ ...at("url"), code: "shape", message: "url must be a non-empty string" });
  if ("command" in entry && !hasCommand) {
    issues.push({ ...at("command"), code: "shape", message: "command must be a non-empty string" });
  }
  if ("args" in entry && (!Array.isArray(entry.args) || entry.args.some((item) => typeof item !== "string"))) {
    issues.push({ ...at("args"), code: "shape", message: "args must be a list of strings" });
  }
  for (const section of SECRET_SECTIONS) {
    if (!(section in entry)) continue;
    if (recordAt(entry, section) === null) {
      issues.push({ ...at(section), code: "shape", message: `${section} must be a flat object of string values` });
    }
  }
  // Belt and braces: resolveMasks already reports what it could not restore, and
  // this makes it impossible for any other path to reach a write with a
  // sentinel still standing where a credential belongs.
  if (containsMask(entry)) {
    issues.push({ ...here(), code: "mask-unresolved", message: "a masked value survived — refusing to write ••• into a config" });
  }
  if (text.length > MAX_JSON_BYTES) {
    issues.push({ ...here(), code: "too-large", message: `that is ${Math.round(text.length / 1024)}KB — far larger than any MCP entry` });
  }
  return issues;
}

// ------------------------------------------------------------------ paste normalisation

function stripJsonComments(text: string): { text: string; removed: boolean } {
  let out = "";
  let removed = false;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      removed = true;
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      removed = true;
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    out += char;
  }
  return { text: out, removed };
}

function stripTrailingCommas(text: string): { text: string; removed: boolean } {
  let out = "";
  let removed = false;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      const rest = text.slice(index + 1);
      const next = /^\s*([}\]])/.exec(rest);
      if (next) {
        removed = true;
        continue;
      }
    }
    out += char;
  }
  return { text: out, removed };
}

/**
 * Make what people actually paste readable, and say out loud what was done to
 * it — a silent fixup is how a user ends up not recognising their own config.
 */
function normalise(raw: string): { text: string; notes: string[]; name: string } {
  const notes: string[] = [];
  let text = raw.trim();
  let name = "";

  if (text.startsWith("```")) {
    text = text
      .replace(/^```[A-Za-z0-9_-]*[ \t]*\r?\n?/, "")
      .replace(/```\s*$/, "")
      .trim();
    notes.push("removed a ``` code fence");
  }

  const addJson = /^(?:\$\s*)?claude\s+mcp\s+add-json\s+(?:-{1,2}[^\s]+\s+)*([A-Za-z0-9_.-]+)\s+(['"])([\s\S]*)\2\s*$/.exec(text);
  if (addJson) {
    name = addJson[1];
    text = addJson[3].trim();
    notes.push(`unwrapped 'claude mcp add-json ${name} …' and took '${name}' as the name`);
  }

  const comments = stripJsonComments(text);
  if (comments.removed) {
    text = comments.text;
    notes.push("removed // and /* */ comments");
  }
  const commas = stripTrailingCommas(text);
  if (commas.removed) {
    text = commas.text;
    notes.push("removed trailing commas");
  }
  return { text: text.trim(), notes, name };
}

function syntaxIssue(text: string, error: unknown): JsonIssue {
  const message = error instanceof Error ? error.message : String(error);
  const position = /position (\d+)/.exec(message);
  if (position) {
    const before = text.slice(0, Number.parseInt(position[1], 10));
    return {
      line: before.split("\n").length,
      column: before.length - before.lastIndexOf("\n"),
      code: "json-syntax",
      message: message.replace(/\s*in JSON at position.*$/, ""),
    };
  }
  const lineCol = /line (\d+) column (\d+)/.exec(message);
  if (lineCol) {
    return { line: Number.parseInt(lineCol[1], 10), column: Number.parseInt(lineCol[2], 10), code: "json-syntax", message };
  }
  return { ...here(), code: "json-syntax", message };
}

// ------------------------------------------------------------------ two-phase write

// `stored` is what the caller already read from this destination — planWrites
// uses it as-is rather than reading the same file again per pair.
type Pair = { dest: Destination; name: string; entry: Entry; stored: Stored | null };

type Plan = {
  issues: JsonIssue[];
  dropped: string[];
  previews: Map<string, string>;
  commit: () => { written: string[]; failed: string[] };
};

function comparable(def: McpDef): string {
  return JSON.stringify({
    command: def.command ?? null,
    args: def.args ?? [],
    url: def.url ?? null,
    env: def.env ?? {},
    headers: def.headers ?? {},
    extra: [...(def.extra ?? [])].map((line) => line.trim()).sort(),
  });
}

/**
 * Build every file this write touches, in memory, and check the result before
 * anything reaches disk. A TOML document is re-parsed and compared against what
 * it was meant to say, because a name or a value that serialises wrong takes the
 * rest of the file down with it. Nothing is written until every pair passes, so
 * a five-server import into seven destinations is all or nothing.
 */
function planWrites(pairs: Pair[]): Plan {
  const issues: JsonIssue[] = [];
  const dropped: string[] = [];
  const previews = new Map<string, string>();
  const documents = new Map<string, { dest: Destination; text: string }>();
  const jsonConfigs = new Map<string, Record<string, unknown>>();

  for (const pair of pairs) {
    const dialect = dialectOf(pair.dest);
    const spec = DIALECTS[dialect];
    const path = pair.dest.configPath;
    const key = `${path}::${pair.name}`;

    const stored = pair.stored;
    const translated = toNative(pair.entry, stored?.carry ?? [], dialect, new Set(Object.keys(stored?.entry ?? {})));
    for (const note of translated.dropped) dropped.push(`${pair.dest.label}: ${note}`);
    previews.set(key, renderNative(translated.native, pair.name, path, spec.headerKey));

    if (translated.native.format === "json-mcp") {
      if (!jsonConfigs.has(path)) {
        // A file that exists but will not parse must never be rewritten: it
        // holds account identity and project history, not only MCP servers.
        const config = existsSync(path) ? readJson(path) : {};
        if (config === null) {
          issues.push({ ...here(), code: "shape", message: `${path} exists but is not valid JSON — refusing to overwrite it` });
          continue;
        }
        jsonConfigs.set(path, config);
      }
      const config = jsonConfigs.get(path);
      if (!config) continue;
      const servers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
      servers[pair.name] = translated.native.value;
      config.mcpServers = servers;
      continue;
    }

    if (!documents.has(path)) {
      try {
        documents.set(path, { dest: pair.dest, text: tomlReadForWrite(path) });
      } catch (error) {
        issues.push({ ...here(), code: "shape", message: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    const document = documents.get(path);
    if (!document) continue;
    let next = "";
    try {
      next = tomlApply(document.text, pair.name, translated.native.def, path, spec.headerKey);
    } catch (error) {
      issues.push({ ...here(), code: "name-invalid", message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const reparsed = tomlMcpReadOneFromText(next, pair.name);
    if (!reparsed || comparable(reparsed) !== comparable(translated.native.def)) {
      issues.push({
        ...here(),
        code: "roundtrip-failed",
        message: `'${pair.name}' did not read back the same from ${pair.dest.label} — nothing was written`,
      });
      continue;
    }
    const usedHeaderTable = reparsed.headerTable ?? spec.headerKey;
    if (translated.native.def.headers && usedHeaderTable !== spec.headerKey) {
      issues.push({
        ...here(),
        code: "roundtrip-failed",
        message: `headers landed in [${usedHeaderTable}] instead of [${spec.headerKey}] for ${pair.dest.label}`,
      });
      continue;
    }
    document.text = next;
  }

  // Serialise JSON once here so the very bytes that were checked are the bytes
  // that get written.
  const jsonTexts = new Map<string, string>();
  for (const [path, config] of jsonConfigs) {
    const text = `${JSON.stringify(config, null, 2)}\n`;
    try {
      JSON.parse(text);
    } catch (error) {
      issues.push({ ...here(), code: "roundtrip-failed", message: `${path}: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    jsonTexts.set(path, text);
  }

  const commit = () => {
    const written: string[] = [];
    const failed: string[] = [];
    const label = (path: string) => pairs.find((pair) => pair.dest.configPath === path)?.dest.label ?? path;
    for (const [path, text] of jsonTexts) {
      try {
        backupFile(path);
        writeTextAtomic(path, text);
        written.push(label(path));
      } catch (error) {
        failed.push(`${label(path)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const [path, document] of documents) {
      try {
        backupFile(path);
        writeTextAtomic(path, document.text);
        written.push(document.dest.label);
      } catch (error) {
        failed.push(`${document.dest.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { written, failed };
  };

  return { issues, dropped, previews, commit };
}

// ------------------------------------------------------------------ raw get / put

export async function handleMcpRawGet({ name, reveal }: { name: string; reveal: boolean }, { paseo }: PluginHandlerContext) {
  const destinations = await buildDestinations(paseo);
  let containsSecrets = false;
  const rows = destinations.map((dest) => {
    const dialect = dialectOf(dest);
    const spec = DIALECTS[dialect];
    const stored = readStored(dest, name);
    if (!stored) {
      return { destId: dest.id, destLabel: dest.label, dialect, found: false, json: "", masked: false, nativePreview: "" };
    }
    const secrets = secretPaths(stored.entry);
    if (secrets.length > 0) containsSecrets = true;
    const shown = reveal ? stored.entry : maskEntry(stored.entry);
    const { native } = toNative(shown, stored.carry, dialect, new Set(Object.keys(stored.entry)));
    return {
      destId: dest.id,
      destLabel: dest.label,
      dialect,
      found: true,
      json: `${JSON.stringify(shown, null, 2)}\n`,
      masked: !reveal && secrets.length > 0,
      nativePreview: renderNative(native, name, dest.configPath, spec.headerKey),
    };
  });
  return { rows, containsSecrets };
}

/** Read one server out of whatever wrapper the buffer happens to use. */
function unwrapSingle(parsed: unknown, name: string): { entry: Entry | null; note: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { entry: null, note: "" };
  const object = parsed as Entry;
  for (const wrapper of ["mcpServers", "servers"] as const) {
    const inner = object[wrapper];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const record = inner as Entry;
      const picked = (record[name] ?? Object.values(record)[0]) as Entry | undefined;
      if (picked && typeof picked === "object") return { entry: picked, note: `read the '${wrapper}' wrapper` };
    }
  }
  if ("url" in object || "command" in object) return { entry: object, note: "" };
  const keys = Object.keys(object);
  if (keys.length === 1) {
    const inner = object[keys[0]];
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return { entry: inner as Entry, note: `read past the outer '${keys[0]}' key` };
    }
  }
  return { entry: object, note: "" };
}

export async function handleMcpRawPut(
  { name, destId, json, dryRun }: { name: string; destId: string; json: string; dryRun: boolean },
  { paseo }: PluginHandlerContext,
) {
  const empty = { ok: false, preview: "", dropped: [] as string[] };
  const destinations = await buildDestinations(paseo);
  const dest = destinations.find((candidate) => candidate.id === destId);
  if (!dest) {
    return {
      ...empty,
      issues: [{ ...here(), code: "not-found" as const, message: `unknown destination ${destId}` }],
      warnings: [],
      message: "nothing written",
    };
  }
  const dialect = dialectOf(dest);
  const { text, notes } = normalise(json);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ...empty, issues: [syntaxIssue(text, error)], warnings: notes, message: "that is not valid JSON — nothing written" };
  }
  const unwrapped = unwrapSingle(parsed, name);
  if (!unwrapped.entry) {
    return {
      ...empty,
      issues: [{ ...here(), code: "shape" as const, message: "expected an object describing one server" }],
      warnings: notes,
      message: "nothing written",
    };
  }
  const warnings = [...notes];
  if (unwrapped.note) warnings.push(unwrapped.note);

  const stored = readStored(dest, name);
  const resolved = resolveMasks(canonicaliseJson(unwrapped.entry), stored?.entry ?? null);
  const issues: JsonIssue[] = resolved.unresolved.map((path) => ({
    ...locate(text, path.split(".").pop() ?? path),
    code: "mask-unresolved" as const,
    message: `${path} is still masked and there is no stored value here to restore — reveal secrets and paste the real one`,
  }));
  issues.push(...validate(resolved.entry, name, dialect, text));

  const plan = planWrites([{ dest, name, entry: resolved.entry, stored }]);
  const preview = plan.previews.get(`${dest.configPath}::${name}`) ?? "";
  issues.push(...plan.issues);

  if (issues.length > 0) {
    return { ok: false, issues, warnings, preview, dropped: plan.dropped, message: "nothing written — fix the problems above" };
  }
  if (dryRun) {
    return { ok: true, issues, warnings, preview, dropped: plan.dropped, message: `'${name}' would be written to ${dest.label}` };
  }
  const { written, failed } = plan.commit();
  return {
    ok: written.length > 0,
    issues,
    warnings,
    preview,
    dropped: plan.dropped,
    message: written.length > 0 ? `wrote '${name}' to ${dest.label} (backup saved)` : failed.join("\n") || "nothing written",
  };
}

// ------------------------------------------------------------------ import

// The one redacting summariser lives in handlers.server.ts; this just reshapes
// a canonical entry into the McpDef it expects.
function summarise(entry: Entry): string {
  return redactDetail({
    url: typeof entry.url === "string" ? entry.url : undefined,
    command: typeof entry.command === "string" ? entry.command : undefined,
    args: Array.isArray(entry.args) ? (entry.args as string[]) : undefined,
  });
}

/** A name for a paste that arrived without one. */
function inferName(entry: Entry): string {
  if (typeof entry.url === "string") {
    try {
      const host = new URL(entry.url).hostname.replace(/^(www|api|mcp)\./, "");
      const slug = host.split(".")[0]?.replace(/[^A-Za-z0-9_-]/g, "-");
      if (slug) return slug;
    } catch {
      // fall through to the command below
    }
  }
  if (typeof entry.command === "string") {
    const args = Array.isArray(entry.args) ? (entry.args as string[]) : [];
    const pkg = args.find((arg) => !arg.startsWith("-"));
    const source = pkg ?? entry.command;
    const slug = basename(source).replace(/^@[^/]+\//, "").replace(/[^A-Za-z0-9_-]/g, "-");
    if (slug) return slug;
  }
  return "server";
}

function parsedRow(name: string, entry: Entry) {
  return {
    name,
    json: `${JSON.stringify(entry, null, 2)}\n`,
    kind: typeof entry.command === "string" ? ("stdio" as const) : ("http" as const),
    summary: summarise(entry),
    hasPlaceholders: placeholderPaths(entry),
  };
}

export async function handleMcpImportParse({ blob }: { blob: string }) {
  const { text, notes, name: wrapperName } = normalise(blob);
  const servers: Array<ReturnType<typeof parsedRow>> = [];
  const issues: JsonIssue[] = [];
  const normalisations = [...notes];

  if (text === "") {
    return { servers, normalisations, issues: [{ ...here(), code: "shape" as const, message: "nothing to read" }] };
  }

  let parsed: unknown;
  let jsonError: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    jsonError = error;
  }

  if (jsonError !== null) {
    // Last shape people paste: a Codex block, lifted straight out of config.toml.
    const names = tomlMcpNamesFromText(text);
    if (names.length === 0) {
      return { servers, normalisations, issues: [syntaxIssue(text, jsonError)] };
    }
    for (const tomlName of names) {
      const def = tomlMcpReadOneFromText(text, tomlName);
      if (!def) {
        issues.push({ ...here(), code: "shape" as const, message: `[mcp_servers.${tomlName}] has neither a url nor a command` });
        continue;
      }
      servers.push(parsedRow(tomlName, tomlToCanonical(def).entry));
    }
    normalisations.push(`read ${servers.length} server(s) out of a TOML [mcp_servers.…] block`);
    return { servers, normalisations, issues };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { servers, normalisations, issues: [{ ...here(), code: "shape" as const, message: "expected a JSON object" }] };
  }
  const object = parsed as Entry;
  const looksLikeServer = (value: unknown): value is Entry =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value) && ("url" in (value as Entry) || "command" in (value as Entry));

  const fromRecord = (record: Entry, note: string) => {
    if (note) normalisations.push(note);
    for (const [key, value] of Object.entries(record)) {
      if (!looksLikeServer(value)) {
        issues.push({ ...locate(text, key), code: "shape" as const, message: `'${key}' has neither a url nor a command` });
        continue;
      }
      servers.push(parsedRow(key, canonicaliseJson(value)));
    }
  };

  const mcpServers = object.mcpServers;
  const plainServers = object.servers;
  if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
    fromRecord(mcpServers as Entry, "read the 'mcpServers' wrapper");
  } else if (plainServers && typeof plainServers === "object" && !Array.isArray(plainServers)) {
    fromRecord(plainServers as Entry, "read the 'servers' wrapper");
  } else if (looksLikeServer(object)) {
    const name = wrapperName || inferName(object);
    if (!wrapperName) normalisations.push(`the paste had no name — called it '${name}'`);
    servers.push(parsedRow(name, canonicaliseJson(object)));
  } else if (Object.values(object).some(looksLikeServer)) {
    fromRecord(object, Object.keys(object).length === 1 ? "took the single top-level key as the server name" : "read a name → server map");
  } else {
    issues.push({ ...here(), code: "shape", message: "could not find a server here — expected mcpServers, a name → server map, or a bare {command…}/{url…}" });
  }
  return { servers, normalisations, issues };
}

export async function handleMcpImportApply(
  {
    servers,
    targets,
    overwrite,
    allowPlaceholders,
  }: { servers: Array<{ name: string; json: string }>; targets: string[]; overwrite: boolean; allowPlaceholders: boolean },
  { paseo }: PluginHandlerContext,
) {
  const destinations = await buildDestinations(paseo);
  const issues: JsonIssue[] = [];
  const skipped: string[] = [];
  const pairs: Pair[] = [];

  const chosen = targets.map((target) => destinations.find((candidate) => candidate.id === target) ?? target);
  for (const entry of chosen) {
    if (typeof entry === "string") issues.push({ ...here(), code: "not-found", message: `unknown destination ${entry}` });
  }
  const dests = chosen.filter((entry): entry is Destination => typeof entry !== "string");

  for (const server of servers) {
    const { text } = normalise(server.json);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      issues.push(syntaxIssue(text, error));
      continue;
    }
    const unwrapped = unwrapSingle(parsed, server.name);
    if (!unwrapped.entry) {
      issues.push({ ...here(), code: "shape", message: `'${server.name}' is not an object describing a server` });
      continue;
    }
    const incoming = canonicaliseJson(unwrapped.entry);
    if (!allowPlaceholders) {
      for (const note of placeholderPaths(incoming)) {
        issues.push({ ...locate(text, note.split(" ")[0].split(".").pop() ?? ""), code: "placeholder", message: `${server.name}: ${note}` });
      }
    }
    for (const dest of dests) {
      const stored = readStored(dest, server.name);
      if (stored && !overwrite) {
        skipped.push(`${dest.label}: '${server.name}' is already there`);
        continue;
      }
      const resolved = resolveMasks(incoming, stored?.entry ?? null);
      for (const path of resolved.unresolved) {
        issues.push({
          ...here(),
          code: "mask-unresolved",
          message: `${server.name} → ${dest.label}: ${path} is still masked and has no stored value here`,
        });
      }
      // Replacing a definition must not quietly switch a disabled server back
      // on: an import carries no opinion about `enabled`, so the stored one wins.
      const entry: Entry = { ...resolved.entry };
      if (!("enabled" in entry) && stored && "enabled" in stored.entry) entry.enabled = stored.entry.enabled;
      issues.push(...validate(entry, server.name, dialectOf(dest), text));
      pairs.push({ dest, name: server.name, entry, stored });
    }
  }

  if (issues.length > 0) {
    return { ok: false, written: [], skipped, issues, message: "nothing was written — every destination is untouched" };
  }
  if (pairs.length === 0) {
    return { ok: false, written: [], skipped, issues, message: skipped.length > 0 ? "everything was already there" : "nothing to write" };
  }
  const plan = planWrites(pairs);
  if (plan.issues.length > 0) {
    return { ok: false, written: [], skipped, issues: plan.issues, message: "nothing was written — every destination is untouched" };
  }
  const { written, failed } = plan.commit();
  const names = [...new Set(pairs.map((pair) => pair.name))];
  return {
    ok: written.length > 0 && failed.length === 0,
    written,
    skipped: [...skipped, ...failed],
    issues: [],
    message: [
      written.length > 0 ? `wrote ${names.length} server(s) to ${written.length} destination(s) (backups saved)` : "nothing written",
      ...plan.dropped,
    ].join("\n"),
  };
}

// ------------------------------------------------------------------ export

/** Everything stored at one destination, read in a single pass over its file. */
function readStoredAll(dest: Destination): Record<string, Stored> {
  if (DIALECTS[dialectOf(dest)].format === "json-mcp") {
    return Object.fromEntries(
      Object.entries(jsonMcpRead(dest.configPath)).map(([name, raw]) => [name, { entry: canonicaliseJson(raw as Entry), carry: [] }]),
    );
  }
  return Object.fromEntries(Object.entries(destRead(dest)).map(([name, def]) => [name, tomlToCanonical(def)]));
}

function bestStored(
  destinations: Destination[],
  storedByDest: Map<string, Record<string, Stored>>,
  name: string,
): { stored: Stored; dest: Destination } | null {
  let fallback: { stored: Stored; dest: Destination } | null = null;
  for (const dest of destinations) {
    const stored = storedByDest.get(dest.id)?.[name];
    if (!stored) continue;
    // A JSON source is already the shape this export speaks, so prefer it.
    if (DIALECTS[dialectOf(dest)].format === "json-mcp") return { stored, dest };
    fallback ??= { stored, dest };
  }
  return fallback;
}

export async function handleMcpExport(
  { scope, name, destId, reveal }: { scope: "one" | "all"; name?: string; destId?: string; reveal: boolean },
  { paseo }: PluginHandlerContext,
) {
  const destinations = await buildDestinations(paseo);
  const chosen = destId ? destinations.find((candidate) => candidate.id === destId) : undefined;
  const pool = chosen ? [chosen] : destinations;
  // One read per destination; every per-name lookup below hits this map.
  const storedByDest = new Map(pool.map((dest) => [dest.id, readStoredAll(dest)] as const));
  const names =
    scope === "one"
      ? [name ?? ""].filter(Boolean)
      : [...new Set([...storedByDest.values()].flatMap((record) => Object.keys(record)))].sort();

  const mcpServers: Record<string, Entry> = {};
  const redacted: string[] = [];
  let anySecrets = false;
  for (const serverName of names) {
    const found = bestStored(pool, storedByDest, serverName);
    if (!found) continue;
    const secrets = secretPaths(found.stored.entry);
    if (secrets.length > 0) anySecrets = true;
    if (!reveal) for (const path of secrets) redacted.push(`${serverName} ${path}`);
    // Export in Claude's shape whatever the source was, so it can be pasted
    // straight back into a README, a colleague's config, or this importer.
    const { native } = toNative(reveal ? found.stored.entry : maskEntry(found.stored.entry), [], "claude-json", new Set(Object.keys(found.stored.entry)));
    if (native.format === "json-mcp") mcpServers[serverName] = native.value;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const header = [`// ${Object.keys(mcpServers).length} MCP server(s) exported by agent-link on ${stamp}`];
  if (redacted.length > 0) {
    header.push(`// ${redacted.length} secret value(s) redacted: ${redacted.slice(0, 6).join(", ")}${redacted.length > 6 ? ", …" : ""}`);
    header.push("// Re-export with secrets revealed to include them.");
  } else if (reveal && anySecrets) {
    header.push("// CONTAINS REAL CREDENTIALS IN PLAIN TEXT — treat this file as a secret.");
  }
  header.push("// The comment lines above are stripped on import.");

  return {
    text: `${header.join("\n")}\n${JSON.stringify({ mcpServers }, null, 2)}\n`,
    filename: scope === "one" && name ? `mcp-${name}.json` : `mcp-servers-${stamp}.json`,
    containsSecrets: reveal && anySecrets,
  };
}

const MAX_EXPORT_BYTES = 4 * 1024 * 1024;

export async function handleMcpExportFile({ text, filename }: { text: string; filename: string }) {
  if (text.trim() === "") return { ok: false, path: "", message: "nothing to write" };
  if (text.length > MAX_EXPORT_BYTES) return { ok: false, path: "", message: "that export is implausibly large — refusing to write it" };
  const safe = basename(filename).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "") || "mcp-servers.json";
  const directory = join(HOME, "Downloads");
  const path = resolve(directory, safe);
  // A filename is client input. Anything that escapes the home directory —
  // traversal, an absolute path, a symlinked name — is refused outright.
  if (!path.startsWith(`${HOME}${sep}`)) return { ok: false, path: "", message: "refusing to write outside your home directory" };
  try {
    mkdirSync(directory, { recursive: true });
    const temporary = `${path}.tmp-agent-link`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600); // an existing file keeps its old mode through a rename
    return { ok: true, path, message: `wrote ${path} (readable only by you)` };
  } catch (error) {
    return { ok: false, path: "", message: error instanceof Error ? error.message : String(error) };
  }
}

// ------------------------------------------------------------------ OAuth

type Live = { session: LoginSession; child: ChildProcess; timer: ReturnType<typeof setTimeout> };

const logins = new Map<string, Live>();

const ANSI = /\[[0-9;]*[A-Za-z]/g;
const LOGIN_TIMEOUT_MS = 120_000;

function cliPath(provider: "claude" | "codex"): string {
  for (const directory of searchPath()) {
    const candidate = join(directory, provider);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

/**
 * The OAuth callback lands on the DAEMON machine's localhost, so a login only
 * completes when the daemon is the machine the user is sitting at. A handler
 * cannot see the browser, and os.hostname() has nothing to be compared against
 * from in here, so this answers the question it can actually answer: is there a
 * CLI to spawn and an account directory for the grant to land in. Anything less
 * certain is reported as false, and the panel hands over the command instead.
 */
function daemonIsLocal(): boolean {
  const haveCli = cliPath("claude") !== "" || cliPath("codex") !== "";
  const haveConfig = existsSync(join(HOME, ".claude.json")) || existsSync(join(HOME, ".codex"));
  return haveCli && haveConfig;
}

function finish(key: string, state: LoginSession["state"], message: string): void {
  const live = logins.get(key);
  if (!live) return;
  clearTimeout(live.timer);
  live.session = { ...live.session, state, message };
}

export async function handleMcpLogin({
  provider,
  accountDir,
  account,
  server,
}: {
  provider: "claude" | "codex";
  accountDir: string;
  account: string;
  server: string;
}) {
  const binary = cliPath(provider);
  if (!binary) return { ok: false, session: null, message: `no '${provider}' on PATH — install it or run the login in a terminal` };
  if (accountDir && !existsSync(accountDir)) return { ok: false, session: null, message: `${accountDir} does not exist` };

  const key = `${provider}|${accountDir}|${server}`;
  const existing = logins.get(key);
  if (existing && (existing.session.state === "starting" || existing.session.state === "waiting")) {
    return { ok: true, session: existing.session, message: "a login for that server is already running" };
  }
  logins.get(key)?.child.kill("SIGTERM");

  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (accountDir) env[envVarFor(provider)] = accountDir;
  const child = spawn(binary, ["mcp", "login", server], { stdio: ["ignore", "pipe", "pipe"], env });

  const session: LoginSession = {
    key,
    server,
    account: account || basename(accountDir || HOME),
    provider,
    state: "starting",
    url: "",
    message: `running '${provider} mcp login ${server}' on ${hostname()}`,
    startedAt: Math.floor(Date.now() / 1000),
  };
  const timer = setTimeout(() => {
    const live = logins.get(key);
    if (!live || live.session.state === "done" || live.session.state === "failed") return;
    live.child.kill("SIGTERM");
    finish(key, "failed", `${provider} mcp login printed no link in ${LOGIN_TIMEOUT_MS / 1000}s — run it in a terminal to see why`);
  }, LOGIN_TIMEOUT_MS);
  const live: Live = { session, child, timer };
  logins.set(key, live);

  let output = "";
  const onChunk = (chunk: Buffer) => {
    output = `${output}${chunk.toString().replace(ANSI, "")}`.slice(-8000);
    if (live.session.url) return;
    const match = /https:\/\/[^\s'"<>()\]]+/.exec(output);
    if (!match) return;
    live.session = { ...live.session, state: "waiting", url: match[0], message: "open the link to finish authorising" };
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  child.once("error", (error) => finish(key, "failed", error.message));
  child.once("exit", (code) => {
    if (code === 0) finish(key, "done", `${server} is authorised for ${session.account}`);
    else finish(key, "failed", output.trim().split("\n").slice(-3).join(" ").slice(0, 300) || `${provider} mcp login exited with ${code}`);
  });

  // Give the CLI a moment to print its link so the first response is useful;
  // the panel polls mcp-login-status for everything after that.
  await new Promise((done) => setTimeout(done, 2500));
  return { ok: true, session: logins.get(key)?.session ?? session, message: live.session.url ? "open the link to finish" : "starting…" };
}

export async function handleMcpLoginStatus() {
  // A finished session is worth showing for a while — it is the only place the
  // panel can say "that worked" — but not forever.
  const cutoff = Math.floor(Date.now() / 1000) - 600;
  for (const [key, live] of logins) {
    const settled = live.session.state === "done" || live.session.state === "failed";
    if (settled && live.session.startedAt < cutoff) logins.delete(key);
  }
  return {
    sessions: [...logins.values()].map((live) => live.session).sort((a, b) => b.startedAt - a.startedAt),
    daemonIsLocal: daemonIsLocal(),
  };
}

export async function handleMcpLoginCancel({ key }: { key: string }) {
  const live = logins.get(key);
  if (!live) return { ok: false, message: "that login is no longer running" };
  clearTimeout(live.timer);
  live.child.kill("SIGTERM");
  logins.delete(key);
  return { ok: true, message: `cancelled ${live.session.provider} mcp login ${live.session.server}` };
}

export async function handleMcpLogout({
  provider,
  accountDir,
  server,
}: {
  provider: "claude" | "codex";
  accountDir: string;
  server: string;
}) {
  const binary = cliPath(provider);
  if (!binary) return { ok: false, message: `no '${provider}' on PATH` };
  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (accountDir) env[envVarFor(provider)] = accountDir;
  return await new Promise<{ ok: boolean; message: string }>((done) => {
    const child = spawn(binary, ["mcp", "logout", server], { stdio: ["ignore", "pipe", "pipe"], env });
    let output = "";
    const onChunk = (chunk: Buffer) => {
      output = `${output}${chunk.toString().replace(ANSI, "")}`.slice(-4000);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      done({ ok: false, message: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      done({
        ok: code === 0,
        message: code === 0 ? `cleared the stored grant for '${server}'` : output.trim().slice(-300) || `${provider} mcp logout exited with ${code}`,
      });
    });
  });
}

/** A login child outlives its RPC on purpose, so nothing else will reap it. */
function mcpLoginShutdown(): void {
  for (const live of logins.values()) {
    clearTimeout(live.timer);
    live.child.kill("SIGTERM");
  }
  logins.clear();
}

onShutdown(mcpLoginShutdown);
