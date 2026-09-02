type AccountProvider = "claude" | "codex";

export type AccountRouteCandidate = {
  email: string;
  poolKey: string;
  last: number;
  preference: "preferred" | "standard" | "reserve";
  nearing: boolean;
};

const preferenceRank = { preferred: 0, standard: 1, reserve: 2 } as const;

export function compareRouteCandidates(left: AccountRouteCandidate, right: AccountRouteCandidate): number {
  return Number(left.nearing) - Number(right.nearing) ||
    preferenceRank[left.preference] - preferenceRank[right.preference] ||
    left.last - right.last ||
    left.poolKey.localeCompare(right.poolKey);
}

export function accountCoveredByManagedBinding(
  provider: AccountProvider,
  email: string,
  bindings: Array<{ provider: AccountProvider; email: string }>,
): boolean {
  const id = `${provider}:${email.trim().toLowerCase()}`;
  return bindings.some(
    (binding) => `${binding.provider}:${binding.email.trim().toLowerCase()}` === id,
  );
}

export function dedupeRouteCandidates(
  provider: AccountProvider,
  candidates: AccountRouteCandidate[],
): AccountRouteCandidate[] {
  const byAccount = new Map<string, AccountRouteCandidate>();
  for (const candidate of candidates) {
    const id = `${provider}:${candidate.email.trim().toLowerCase()}`;
    const current = byAccount.get(id);
    if (!current || compareRouteCandidates(candidate, current) < 0) byAccount.set(id, candidate);
  }
  return [...byAccount.values()];
}
