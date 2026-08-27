export type ProcessRow = {
  pid: number;
  ppid: number;
  rssKb: number;
  state: string;
  elapsedSeconds: number;
  command: string;
};

export type GovernorPlan = {
  pause: ProcessRow[];
  resume: ProcessRow[];
  reason: "concurrency" | "pressure" | "none";
};

/** Parse the stable, headerless format requested from ps by resources.server. */
export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssKb: Number(match[3]),
      state: match[4] ?? "",
      elapsedSeconds: parseElapsed(match[5] ?? ""),
      command: match[6] ?? "",
    });
  }
  return rows;
}

function parseElapsed(value: string): number {
  const daySplit = value.split("-");
  const clock = (daySplit.length > 1 ? daySplit[1] : daySplit[0])?.split(":").map(Number) ?? [];
  const days = daySplit.length > 1 ? Number(daySplit[0]) : 0;
  if (clock.some((part) => !Number.isFinite(part))) return 0;
  if (clock.length === 3) return days * 86_400 + (clock[0] ?? 0) * 3_600 + (clock[1] ?? 0) * 60 + (clock[2] ?? 0);
  if (clock.length === 2) return days * 86_400 + (clock[0] ?? 0) * 60 + (clock[1] ?? 0);
  return 0;
}

function executable(command: string): string {
  return command.trim().split(/\s+/, 1)[0]?.split("/").pop() ?? "";
}

export function isTypecheckProcess(command: string): boolean {
  return (
    /(?:^|\/)node_modules\/(?:\.bin\/(?:tsc|vue-tsc)|typescript\/(?:bin\/tsc|lib\/tsc\.js))(?:\s|$)/.test(command) ||
    /(?:^|\s|\/)(?:tsc|vue-tsc|tsgo)(?:\s|$)/.test(command)
  );
}

/**
 * Return only type-check processes owned by a provider process beneath the
 * Paseo daemon. This ancestry check is the safety boundary: a type-check the
 * person started in Terminal is never touched.
 */
export function paseoTypechecks(rows: ProcessRow[]): ProcessRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const daemonPids = new Set(
    rows
      .filter((row) => /(?:^|\/)(?:Paseo Daemon)(?:\s|$)|daemon-worker\.js(?:\s|$)/.test(row.command))
      .map((row) => row.pid),
  );
  const providerRoots = new Set<number>();
  for (const row of rows) {
    if (executable(row.command) !== "claude" && executable(row.command) !== "codex") continue;
    let parent = byPid.get(row.ppid);
    const seen = new Set<number>();
    while (parent && !seen.has(parent.pid)) {
      if (daemonPids.has(parent.pid)) {
        providerRoots.add(row.pid);
        break;
      }
      seen.add(parent.pid);
      parent = byPid.get(parent.ppid);
    }
  }

  return rows.filter((row) => {
    if (!isTypecheckProcess(row.command)) return false;
    let parent = byPid.get(row.ppid);
    const seen = new Set<number>();
    while (parent && !seen.has(parent.pid)) {
      if (providerRoots.has(parent.pid)) return true;
      seen.add(parent.pid);
      parent = byPid.get(parent.ppid);
    }
    return false;
  });
}

/** Oldest check keeps the lane: it is normally closest to releasing its RAM. */
export function planGovernorActions(
  candidates: ProcessRow[],
  ownedPausedPids: ReadonlySet<number>,
  freePercent: number | null,
  options: { maxActive: number; pauseAtPercent: number; resumeAtPercent: number; pressureMinRssKb: number },
): GovernorPlan {
  const active = candidates
    .filter((row) => !row.state.includes("T"))
    .sort((a, b) => b.elapsedSeconds - a.elapsedSeconds || b.rssKb - a.rssKb);
  const paused = candidates
    .filter((row) => row.state.includes("T") && ownedPausedPids.has(row.pid))
    .sort((a, b) => b.elapsedSeconds - a.elapsedSeconds);

  if (freePercent !== null && freePercent <= options.pauseAtPercent) {
    return {
      pause: active.filter((row) => row.rssKb >= options.pressureMinRssKb),
      resume: [],
      reason: "pressure",
    };
  }

  const pause = active.slice(Math.max(0, options.maxActive));
  const projectedActive = active.length - pause.length;
  const mayResume = freePercent === null || freePercent >= options.resumeAtPercent;
  const resume = projectedActive < options.maxActive && mayResume ? paused.slice(0, options.maxActive - projectedActive) : [];
  return { pause, resume, reason: pause.length > 0 ? "concurrency" : "none" };
}
