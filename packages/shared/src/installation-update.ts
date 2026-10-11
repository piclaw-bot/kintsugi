import { Type, type Static } from "typebox";
export const updaterSocket = "/run/kintsugi-updater/control.sock";
const image = Type.String({ pattern: "^(?:ghcr\\.io|docker\\.io)/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$" });
export const installationPlanSchema = Type.Object({ id: Type.String({ pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" }), app: image, system: image, available: Type.Boolean(), selection: Type.String(), previousSystem: Type.String(), previousApp: Type.String() }, { additionalProperties: false });
export type InstallationPlan = Static<typeof installationPlanSchema>;
export const installationUpdateSchema = Type.Object({ phase: Type.Union([Type.Literal("idle"), Type.Literal("available"), Type.Literal("preparing"), Type.Literal("ready"), Type.Literal("updating"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("rolled-back")]), plan: Type.Optional(installationPlanSchema), retainedPlan: Type.Optional(installationPlanSchema), message: Type.String() }, { additionalProperties: false });
export type InstallationUpdate = Static<typeof installationUpdateSchema>;
