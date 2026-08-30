import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const ResourceProcessSchema = z.object({
  pid: z.number(),
  rssMb: z.number(),
  label: z.string(),
  pausedAt: z.string(),
});
export type ResourceProcess = z.infer<typeof ResourceProcessSchema>;

export const ResourceEventSchema = z.object({
  at: z.string(),
  action: z.enum(["paused", "resumed"]),
  pid: z.number(),
  rssMb: z.number(),
  label: z.string(),
  reason: z.string(),
});
export type ResourceEvent = z.infer<typeof ResourceEventSchema>;

export const FleetGuardSchema = z.object({
  available: z.boolean(),
  fresh: z.boolean(),
  pressured: z.boolean(),
  reasons: z.array(z.string()),
  healthyCount: z.number(),
  instanceCount: z.number(),
  checkedAt: z.string().nullable(),
});
export type FleetGuard = z.infer<typeof FleetGuardSchema>;

export const ResourceStatusSchema = z.object({
  watching: z.boolean(),
  enabled: z.boolean(),
  freePercent: z.number().nullable(),
  activeTypechecks: z.number(),
  fleetGuard: FleetGuardSchema,
  paused: z.array(ResourceProcessSchema),
  events: z.array(ResourceEventSchema),
});
export type ResourceStatus = z.infer<typeof ResourceStatusSchema>;

export const resourceStatus = defineRpc({
  name: "agent-link.resource-status",
  input: z.object({}),
  output: ResourceStatusSchema,
});

export const resourceSetEnabled = defineRpc({
  name: "agent-link.resource-set-enabled",
  input: z.object({ enabled: z.boolean() }),
  output: ResourceStatusSchema,
});
