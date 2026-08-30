import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * The CLI, from the panel.
 *
 * Most of this plugin works without the agent-link CLI: it reads account and
 * provider state itself. The one thing it cannot do alone is host the
 * AgentLink ACP provider—the runtime command has to exist on disk.
 *
 * So rather than telling someone to go and find a terminal, the panel offers to
 * install it: one file into ~/.local/bin, then the ACP runtime. The exact command
 * is always shown too, for anyone who would rather
 * run it themselves.
 */

export const CliStatusSchema = z.object({
  installed: z.boolean(),
  path: z.string(),
  version: z.string(),
  /** Where it would be installed, and whether that is on the daemon's PATH. */
  binDir: z.string(),
  onPath: z.boolean(),
  /** The curl one-liner, for someone who would rather do it by hand. */
  command: z.string(),
  /** The one-chat AgentLink ACP runtime exists. */
  routersReady: z.boolean(),
});
export type CliStatus = z.infer<typeof CliStatusSchema>;

export const cliStatus = defineRpc({
  name: "agent-link.cli-status",
  input: z.object({}),
  output: CliStatusSchema,
});

export const cliInstall = defineRpc({
  name: "agent-link.cli-install",
  input: z.object({
    /** Also install the AgentLink ACP runtime. Kept under the old key for RPC compatibility. */
    withRouters: z.boolean(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string(), status: CliStatusSchema }),
});

/** The plugin's own release update, separate from provider quota probes. */
export const cliUpdateCheck = defineRpc({
  name: "agent-link.update-check",
  input: z.object({}),
  output: z.object({
    installedVersion: z.string(),
    latestVersion: z.string(),
    /** Kept for ancestry checks and older build stamps; never shown as the release identity. */
    installedSha: z.string(),
    latestSha: z.string(),
    updateReady: z.boolean(),
    note: z.string(),
  }),
});

export const cliUpdateApply = defineRpc({
  name: "agent-link.update-apply",
  input: z.object({}),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
