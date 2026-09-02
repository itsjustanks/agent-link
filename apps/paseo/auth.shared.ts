import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const AccountProviderSchema = z.enum(["claude", "codex"]);
export const AccountSourceSchema = z.enum(["primary", "agent-link", "external"]);
export const AccountLoginStatusSchema = z.enum(["starting", "awaiting_code", "waiting", "succeeded", "failed", "cancelled"]);

export const AccountLoginSessionSchema = z.object({
  id: z.string(),
  provider: AccountProviderSchema,
  source: AccountSourceSchema,
  email: z.string(),
  status: AccountLoginStatusSchema,
  url: z.string().nullable(),
  userCode: z.string().nullable(),
  message: z.string(),
  startedAt: z.number(),
  expiresAt: z.number(),
});
export type AccountLoginSession = z.infer<typeof AccountLoginSessionSchema>;
export type AccountSource = z.infer<typeof AccountSourceSchema>;

const AccountLoginTargetSchema = z.object({
  provider: AccountProviderSchema,
  source: AccountSourceSchema,
  email: z.string().max(320),
});

export const accountLoginSessions = defineRpc({
  name: "agent-link.account-login-sessions",
  input: z.object({}),
  output: z.object({ sessions: z.array(AccountLoginSessionSchema) }),
});

export const accountLoginStart = defineRpc({
  name: "agent-link.account-login-start",
  input: AccountLoginTargetSchema,
  output: AccountLoginSessionSchema,
});

export const accountLoginSubmit = defineRpc({
  name: "agent-link.account-login-submit",
  input: z.object({
    sessionId: z.string().min(1).max(200),
    code: z.string().trim().min(1).max(8_192),
  }),
  output: AccountLoginSessionSchema,
});

export const accountLoginCancel = defineRpc({
  name: "agent-link.account-login-cancel",
  input: z.object({ sessionId: z.string().min(1).max(200) }),
  output: AccountLoginSessionSchema,
});
