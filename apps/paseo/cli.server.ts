import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { CliStatus } from "./cli.shared";

const HOME = homedir();
const SOURCE = "https://raw.githubusercontent.com/itsjustanks/paseo-agent-link/main/agent-link";
const BIN_DIR = join(HOME, ".local", "bin");
const INSTALL_COMMAND = `mkdir -p ~/.local/bin && curl -fsSL ${SOURCE} -o ~/.local/bin/agent-link && chmod +x ~/.local/bin/agent-link`;

/** Where a launcher lands, mirroring the CLI's own layout. */
function launcher(provider: "claude" | "codex"): string[] {
  return [
    join(HOME, ".agent-link", "bin", `${provider}-auto`),
    join(HOME, ".agent-auth", "bin", `${provider}-auto`),
  ];
}

function findCli(): string {
  const candidates = [
    join(BIN_DIR, "agent-link"),
    join(HOME, "bin", "agent-link"),
    "/usr/local/bin/agent-link",
    "/opt/homebrew/bin/agent-link",
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "agent-link")),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // next
    }
  }
  return "";
}

function versionOf(path: string): string {
  try {
    return execFileSync(path, ["--version"], { encoding: "utf8", timeout: 8_000 }).trim().split("\n")[0] ?? "";
  } catch {
    return "";
  }
}

export function cliState(): CliStatus {
  const path = findCli();
  const onPath = (process.env.PATH ?? "").split(delimiter).includes(BIN_DIR);
  return {
    installed: Boolean(path),
    path,
    version: path ? versionOf(path) : "",
    binDir: BIN_DIR,
    onPath,
    command: INSTALL_COMMAND,
    routersReady: (["claude", "codex"] as const).some((provider) => launcher(provider).some((file) => existsSync(file))),
  };
}

export async function handleCliStatus(): Promise<CliStatus> {
  return cliState();
}

// ------------------------------------------------------------ plugin updates

// Updates follow RELEASES: compare the installed build against the latest
// release tag's commit, falling back to main only when no release resolves.
const LATEST_RELEASE_URL = "https://api.github.com/repos/itsjustanks/paseo-agent-link/releases/latest";
const COMMIT_SHA_URL = (ref: string) => `https://api.github.com/repos/itsjustanks/paseo-agent-link/commits/${encodeURIComponent(ref)}`;
const COMPARE_URL = (base: string, head: string) =>
  `https://api.github.com/repos/itsjustanks/paseo-agent-link/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;

function pluginInfo(command: "ls" | "status"): Record<string, unknown> | null {
  try {
    const args = command === "ls" ? ["plugin", "ls", "--json"] : ["plugin", "status", "agent-link", "--json"];
    const parsed = JSON.parse(execFileSync("paseo", args, { encoding: "utf8", timeout: 8_000 })) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return (rows.find((row) => row && typeof row === "object" && (row as { id?: string }).id === "agent-link") as Record<string, unknown> | undefined) ?? null;
  } catch {
    return null;
  }
}

function pluginSource(): string {
  const source = pluginInfo("status")?.source;
  return typeof source === "string" ? source : "";
}

// Prefer Paseo's registered path. Fixed legacy locations preserve update
// identity for older directory installs.
function buildStamp(): { sha: string; version: string } {
  const registeredPath = pluginInfo("ls")?.path;
  const candidates = [
    ...(typeof registeredPath === "string" ? [join(registeredPath, "build.json"), join(registeredPath, "package.json")] : []),
    join(HOME, ".paseo", "plugins", "agent-link", "build.json"),
    join(HOME, ".paseo", "plugins", "agent-link", "package.json"),
    join(HOME, "Library", "Application Support", "paseo", "plugins", "agent-link", "build.json"),
    join(HOME, ".config", "paseo", "plugins", "agent-link", "build.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { sha?: string; version?: string };
      if (typeof parsed.sha === "string" || typeof parsed.version === "string") {
        return {
          sha: typeof parsed.sha === "string" ? parsed.sha : "",
          version: typeof parsed.version === "string" ? parsed.version : "",
        };
      }
    } catch {
      // next
    }
  }
  return { sha: "", version: "" };
}

function compareReleaseVersions(left: string, right: string): number {
  const parts = (value: string) => value.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export async function handleCliUpdateCheck(): Promise<{
  installedVersion: string;
  latestVersion: string;
  installedSha: string;
  latestSha: string;
  updateReady: boolean;
  note: string;
}> {
  const installed = buildStamp();
  const installedSha = installed.sha;
  let installedVersion = installed.version;
  let latestVersion = "";
  let latestSha = "";
  try {
    let ref = "main";
    try {
      const release = await fetch(LATEST_RELEASE_URL, { signal: AbortSignal.timeout(8_000) });
      if (release.ok) {
        const tag = ((await release.json()) as { tag_name?: string }).tag_name;
        if (typeof tag === "string" && tag) {
          ref = tag;
          latestVersion = tag.replace(/^v/, "");
        }
      }
    } catch {
      // No release info — main is still an honest comparison point.
    }
    // This media type answers with the bare sha, nothing to parse.
    const response = await fetch(COMMIT_SHA_URL(ref), {
      headers: { accept: "application/vnd.github.sha" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    latestSha = (await response.text()).trim();
  } catch (caught) {
    return {
      installedVersion,
      latestVersion,
      installedSha,
      latestSha: "",
      updateReady: false,
      note: `Could not reach GitHub: ${caught instanceof Error ? caught.message : String(caught)}`,
    };
  }
  if (!installedSha) {
    if (installedVersion && latestVersion) {
      const comparison = compareReleaseVersions(installedVersion, latestVersion);
      return {
        installedVersion,
        latestVersion,
        installedSha,
        latestSha,
        updateReady: comparison < 0,
        note: comparison > 0 ? "Installed build is newer than the latest release." : "",
      };
    }
    return {
      installedVersion,
      latestVersion,
      installedSha,
      latestSha,
      updateReady: true,
      note: "This install predates release-number stamps. Updating once brings it current and records the release number.",
    };
  }
  if (installedSha === latestSha) {
    if (!installedVersion) installedVersion = latestVersion;
    return { installedVersion, latestVersion, installedSha, latestSha, updateReady: false, note: "" };
  }
  // A developer/local install can be newer than the latest published release.
  // Equality alone called that an update and offered to downgrade it. Ask GitHub
  // for ancestry: base=release, head=installed means `ahead` is already newer.
  try {
    const comparison = await fetch(COMPARE_URL(latestSha, installedSha), { signal: AbortSignal.timeout(8_000) });
    if (comparison.ok) {
      const status = ((await comparison.json()) as { status?: string }).status;
      if (status === "ahead" || status === "identical") {
        return {
          installedVersion: installedVersion || "development",
          latestVersion,
          installedSha,
          latestSha,
          updateReady: false,
          note: "Installed build is newer than the latest release.",
        };
      }
    }
  } catch {
    // Fall through to the conservative mismatch check below.
  }
  return {
    installedVersion,
    latestVersion,
    installedSha,
    latestSha,
    updateReady: installedSha !== latestSha,
    note: "",
  };
}

export async function handleCliUpdateApply(): Promise<{ ok: boolean; message: string }> {
  const cli = findCli();
  const gitManaged = pluginSource() === "git";
  if (!gitManaged && !cli) {
    return { ok: false, message: "The agent-link CLI is not installed — install it from the card above first." };
  }
  // Updating replaces this running plugin, so start it after this RPC response
  // has flushed. Paseo's Git flow validates the candidate and rolls back on a
  // startup failure; older directory installs retain the CLI fallback.
  try {
    const command = gitManaged
      ? "paseo plugin update agent-link"
      : `${JSON.stringify(cli)} app install paseo`;
    const child = spawn("/bin/sh", ["-c", `sleep 1; ${command} >/dev/null 2>&1`], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return {
      ok: true,
      message:
        "Update started. Paseo is validating the new release and will keep the current plugin if it cannot start. Reopen this tab in about 30 seconds.",
    };
  } catch (caught) {
    return {
      ok: false,
      message: `Could not start the update: ${caught instanceof Error ? caught.message.split("\n")[0] : String(caught)}. Run 'agent-link app install paseo' in a terminal instead.`,
    };
  }
}

export async function handleCliInstall({ withRouters }: { withRouters: boolean }): Promise<{
  ok: boolean;
  message: string;
  status: CliStatus;
}> {
  const target = join(BIN_DIR, "agent-link");
  try {
    const response = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const text = await response.text();
    // A truncated or redirected download would install a broken file that then
    // fails in confusing ways; a shell script that does not start like one is
    // not the thing we asked for.
    if (text.length < 5_000 || !text.startsWith("#!")) {
      throw new Error("that download does not look like the CLI — install it by hand instead");
    }
    mkdirSync(BIN_DIR, { recursive: true });
    const staged = `${target}.download`;
    writeFileSync(staged, text, { mode: 0o755 });
    chmodSync(staged, 0o755);
    renameSync(staged, target);

    const version = versionOf(target);
    if (!version) throw new Error(`installed to ${target} but it would not run — check it by hand`);

    let note = "";
    if (withRouters) {
      try {
        execFileSync(target, ["auto"], { encoding: "utf8", timeout: 30_000 });
        note = " Routing launchers written — install the provider above.";
      } catch (caught) {
        note = ` The CLI is in, but writing the launchers failed (${
          caught instanceof Error ? caught.message.split("\n")[0] : String(caught)
        }). Run 'agent-link auto' in a terminal.`;
      }
    }

    const status = cliState();
    const pathNote = status.onPath
      ? ""
      : ` ${BIN_DIR} is not on this machine's PATH, so add it to your shell profile before using the command in a terminal.`;
    return { ok: true, message: `Installed agent-link ${version} to ${target}.${note}${pathNote}`, status };
  } catch (caught) {
    return {
      ok: false,
      message: caught instanceof Error ? caught.message : String(caught),
      status: cliState(),
    };
  }
}
