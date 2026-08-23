import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * The CLI, from the panel.
 *
 * Most of this plugin works without the agent-link CLI: it reads the account
 * directories itself, syncs MCP definitions itself, and renders canvases
 * itself. The one thing it cannot do alone is routing — that needs the little
 * launcher script the CLI writes, because a Paseo provider runs a command, and
 * the command has to exist on disk.
 *
 * So rather than telling someone to go and find a terminal, the panel offers to
 * install it: one file into ~/.local/bin, then the launchers, then routing is
 * available. The exact command is always shown too, for anyone who would rather
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
  /** Launchers exist, so routing can be installed from the panel. */
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
    /** Also write the routing launchers, which is the point of installing it. */
    withRouters: z.boolean(),
  }),
  output: z.object({ ok: z.boolean(), message: z.string(), status: CliStatusSchema }),
});
