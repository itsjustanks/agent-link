export const UNKNOWN_MODEL = "Unknown (runtime not exposed)";

export interface RuntimeModelIdentity {
  provider: string;
  model: string;
}

/**
 * Paseo normally exposes provider and model separately. Some CLI projections
 * encode them as `provider/model` and leave model null, so accept both shapes.
 */
export function resolveRuntimeModel(provider: string | null | undefined, model: string | null | undefined): RuntimeModelIdentity {
  const rawProvider = provider?.trim() || "Unknown provider";
  const rawModel = model?.trim();
  const separator = rawProvider.indexOf("/");
  const providerId = separator > 0 ? rawProvider.slice(0, separator) : rawProvider;
  if (rawModel) return { provider: providerId, model: rawModel };
  if (separator > 0 && separator < rawProvider.length - 1) {
    return { provider: providerId, model: rawProvider.slice(separator + 1) };
  }
  return { provider: providerId, model: UNKNOWN_MODEL };
}

const FRIENDLY_MODELS: Record<string, string> = {
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-fable-5": "Claude Fable 5",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-5": "Claude Opus 5",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "grok-4.5": "Grok 4.5",
  "grok-4.6": "Grok 4.6",
  "kimi-code/k3": "Kimi K3",
  "kimi-code/kimi-for-coding-highspeed": "Kimi Highspeed",
};

export function friendlyModelName(model: string): string {
  return FRIENDLY_MODELS[model] ?? model;
}
