import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

// The limit sentry: a resident watcher in the plugin daemon that notices when
// a Paseo agent dies on a provider usage limit and — with auto on — pokes it
// back to life through Paseo's own agent API. The relaunch runs through the
// agent-link launcher, so the resumed conversation lands on a healthy account.

export const LimitEventSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  title: z.string().nullable(),
  provider: z.string(),
  at: z.string(),
  action: z.enum(["auto-resumed", "recovery-queued", "needs-resume", "resume-failed"]),
  detail: z.string(),
  account: z.string().optional(),
  model: z.string().optional(),
  limit: z.string().optional(),
});
export type LimitEvent = z.infer<typeof LimitEventSchema>;

export const LimitsStatusSchema = z.object({
  watching: z.boolean(),
  auto: z.boolean(),
  events: z.array(LimitEventSchema),
});
export type LimitsStatus = z.infer<typeof LimitsStatusSchema>;

export const limitsStatus = defineRpc({
  name: "agent-link.limits-status",
  input: z.object({}),
  output: LimitsStatusSchema,
});

export const limitsSetAuto = defineRpc({
  name: "agent-link.limits-set-auto",
  input: z.object({ auto: z.boolean() }),
  output: LimitsStatusSchema,
});

export const limitsResume = defineRpc({
  name: "agent-link.limits-resume",
  input: z.object({ agentId: z.string() }),
  output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});
