import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { CliStatus } from "./cli.shared";

const HOME = homedir();
const SOURCE = "https://raw.githubusercontent.com/itsjustanks/agent-link/main/agent-link";
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
