import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * Canvas — the HTML your agents write, viewable and shareable.
 *
 * An agent asked for a dashboard, a report or a diagram produces a file. Until
 * now that file sat in a worktree you had to find in a terminal. This serves it
 * from the daemon machine and, on request, puts it behind a Cloudflare quick
 * tunnel so a link works anywhere. Nothing is uploaded: the file is read from
 * disk on each request and the tunnel dies with the plugin.
 */

export const ArtifactSchema = z.object({
  path: z.string(), // absolute file path — also the identity
  name: z.string(),
  title: z.string(), // <title> when the file has one, else the file name
  dir: z.string(),
  where: z.string(), // workspace or folder this came from
  bytes: z.number(),
  modified: z.number(), // epoch seconds
  localUrl: z.string(), // "" until it is being served
  publicUrl: z.string(), // "" unless the tunnel is up and it is shared
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const TunnelStateSchema = z.enum(["off", "starting", "on", "failed"]);

/** What is missing, and the one command that fixes it. */
export const RequirementSchema = z.object({
  installed: z.boolean(),
  path: z.string(),
  install: z.string(), // e.g. "brew install cloudflared"
  note: z.string(),
});

export const CanvasStateSchema = z.object({
  artifacts: z.array(ArtifactSchema),
  roots: z.array(z.string()), // where we looked, so an empty list explains itself
  serving: z.array(z.string()), // paths currently served
  serverUrl: z.string(), // "" until something is served
  tunnel: z.object({
    state: TunnelStateSchema,
    url: z.string(),
    error: z.string(),
    since: z.number(),
  }),
  cloudflared: RequirementSchema,
  error: z.string(),
});
export type CanvasState = z.infer<typeof CanvasStateSchema>;

const empty = z.object({});

export const canvasState = defineRpc({
  name: "agent-link.canvas-state",
  input: z.object({ refresh: z.boolean().optional() }),
  output: CanvasStateSchema,
});

/** Serve one artifact locally; `share: true` also brings the tunnel up. */
export const canvasServe = defineRpc({
  name: "agent-link.canvas-serve",
  input: z.object({ path: z.string(), share: z.boolean() }),
  output: CanvasStateSchema,
});

export const canvasStop = defineRpc({
  name: "agent-link.canvas-stop",
  input: z.object({ path: z.string().optional() }), // no path = stop everything
  output: CanvasStateSchema,
});

export const canvasOpen = defineRpc({
  name: "agent-link.canvas-open",
  input: z.object({ url: z.string() }),
  output: z.object({ opened: z.boolean(), message: z.string() }),
});

export const canvasCopy = defineRpc({
  name: "agent-link.canvas-copy",
  input: z.object({ url: z.string() }),
  output: z.object({ copied: z.boolean() }),
});
