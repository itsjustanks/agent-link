export type AccountAuthProvider = "claude" | "codex";

export function stripTerminal(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function trustedAuthUrl(provider: AccountAuthProvider, text: string): string | null {
  const allowed = provider === "claude"
    ? ["claude.com", "claude.ai", "platform.claude.com", "console.anthropic.com"]
    : ["auth.openai.com", "chatgpt.com", "platform.openai.com"];
  for (const raw of stripTerminal(text).match(/https:\/\/[^\s<>"']+/g) ?? []) {
    const candidate = raw.replace(/[),.;]+$/, "");
    try {
      const parsed = new URL(candidate);
      if (allowed.some((host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))) return parsed.toString();
    } catch {
      // Ignore malformed provider output.
    }
  }
  return null;
}

export function deviceCode(text: string): string | null {
  const clean = stripTerminal(text);
  const marker = clean.toLowerCase().indexOf("one-time code");
  if (marker < 0) return null;
  return clean.slice(marker).match(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4,8})+\b/)?.[0] ?? null;
}
