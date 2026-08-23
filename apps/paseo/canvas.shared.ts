import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

/**
 * Canvas — what your agents built, shown inside Paseo.
 *
 * An agent asked for a dashboard, a report or a diagram writes a file into a
 * worktree you would otherwise have to go and find. This finds it, renders it
 * on the daemon, and shows it in the panel. Rendering happens on the daemon
 * because a plugin surface is React Native — there is no WebView to put HTML
 * in — and because opening a browser is useless when the daemon is a server
 * somewhere else.
 *
 * Sharing is separate and optional: a Cloudflare quick tunnel for when someone
 * else needs the live, interactive page rather than a picture of it.
 */

export const ArtifactKindSchema = z.enum(["html", "markdown", "svg", "image"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactSchema = z.object({
  path: z.string(), // absolute file path — also the identity
  name: z.string(),
  title: z.string(), // <title>, first heading, or the file name
  dir: z.string(), // display form, ~ for home
  where: z.string(), // workspace or folder this came from
  kind: ArtifactKindSchema,
  bytes: z.number(),
  modified: z.number(), // epoch seconds
  localUrl: z.string(), // "" unless being served
  publicUrl: z.string(), // "" unless shared through the tunnel
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const TunnelStateSchema = z.enum(["off", "starting", "on", "failed"]);

/** Something the machine is missing, and the one command that fixes it. */
export const RequirementSchema = z.object({
  installed: z.boolean(),
  path: z.string(),
  install: z.string(),
  note: z.string(),
});

export const CanvasStateSchema = z.object({
  artifacts: z.array(ArtifactSchema),
  roots: z.array(z.string()),
  serving: z.array(z.string()),
  serverUrl: z.string(),
  tunnel: z.object({
    state: TunnelStateSchema,
    url: z.string(),
    error: z.string(),
    since: z.number(),
  }),
  /** Chrome, for rendering in the panel. */
  renderer: RequirementSchema,
  /** cloudflared, for public links. */
  cloudflared: RequirementSchema,
  error: z.string(),
});
export type CanvasState = z.infer<typeof CanvasStateSchema>;

const empty = z.object({});

export const canvasState = defineRpc({
  name: "agent-link.canvas-state",
  input: z.object({ refresh: z.boolean().optional(), workspaceDir: z.string().optional() }),
  output: CanvasStateSchema,
});

/** Colours handed to generated pages so a report matches the app it sits in. */
export const PageThemeSchema = z.object({
  background: z.string(),
  foreground: z.string(),
  muted: z.string(),
  accent: z.string(),
});

export const RenderSchema = z.object({
  dataUri: z.string(), // data:image/<format>;base64,… ready for <Image>
  base64: z.string(), // the same bytes, for posting into a chat message
  format: z.enum(["webp", "png"]),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
  truncated: z.boolean(), // the page was taller than the cap
  title: z.string(),
  fromCache: z.boolean(),
  ms: z.number(),
});
export type Render = z.infer<typeof RenderSchema>;

export const canvasRender = defineRpc({
  name: "agent-link.canvas-render",
  input: z.object({
    path: z.string(),
    width: z.number().min(320).max(2400),
    scale: z.number().min(1).max(3),
    theme: PageThemeSchema.optional(),
    // Chat attachments are safest as PNG; the panel itself prefers WebP.
    format: z.enum(["webp", "png"]).optional(),
  }),
  output: RenderSchema,
});

/** Serve one artifact locally; `share: true` also brings the tunnel up. */
export const canvasServe = defineRpc({
  name: "agent-link.canvas-serve",
  input: z.object({ path: z.string(), share: z.boolean(), theme: PageThemeSchema.optional() }),
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

/** The artifact's own source, for reading a report without rendering it. */
export const canvasSource = defineRpc({
  name: "agent-link.canvas-source",
  input: z.object({ path: z.string() }),
  output: z.object({ text: z.string(), truncated: z.boolean(), bytes: z.number() }),
});
