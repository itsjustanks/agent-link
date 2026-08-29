import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const ToolchainProviderSchema = z.object({
  id: z.string(),
  label: z.string(),
  availableInPaseo: z.boolean(),
  installed: z.boolean(),
  managed: z.boolean(),
  builtIn: z.boolean(),
  binary: z.string(),
  version: z.string(),
  versionArgs: z.array(z.string()),
  updateArgs: z.array(z.string()),
  processPattern: z.string(),
  lastResult: z.string(),
  lastChecked: z.string(),
  detail: z.string(),
});
export type ToolchainProvider = z.infer<typeof ToolchainProviderSchema>;

export const ToolchainStatusSchema = z.object({
  enabled: z.boolean(),
  schedule: z.string(),
  providers: z.array(ToolchainProviderSchema),
});

export const toolchainStatus = defineRpc({
  name: "agent-link.toolchain-status",
  input: z.object({}),
  output: ToolchainStatusSchema,
});

export const toolchainConfigure = defineRpc({
  name: "agent-link.toolchain-configure",
  input: z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    label: z.string().min(1).max(100),
    binary: z.string().min(1).max(500),
    versionArgs: z.array(z.string().max(200)).max(12),
    updateArgs: z.array(z.string().max(200)).min(1).max(20),
    processPattern: z.string().min(1).max(500),
  }),
  output: z.object({ ok: z.boolean(), message: z.string(), status: ToolchainStatusSchema }),
});

export const toolchainRemove = defineRpc({
  name: "agent-link.toolchain-remove",
  input: z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
  output: z.object({ ok: z.boolean(), message: z.string(), status: ToolchainStatusSchema }),
});

export const toolchainRun = defineRpc({
  name: "agent-link.toolchain-run",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});

export const toolchainSetEnabled = defineRpc({
  name: "agent-link.toolchain-set-enabled",
  input: z.object({ enabled: z.boolean() }),
  output: z.object({ ok: z.boolean(), message: z.string(), status: ToolchainStatusSchema }),
});
