import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const accessModeSchema = Type.Union([Type.Literal("localhost"), Type.Literal("tailscale"), Type.Literal("proxy")]);
export const proxyAccessSchema = Type.Object({
  origin: Type.String(),
  previewPorts: Type.Object({ start: Type.Integer({ minimum: 41000, maximum: 41999 }), end: Type.Integer({ minimum: 41000, maximum: 41999 }) }, { additionalProperties: false }),
  adminPort: Type.Optional(Type.Integer({ minimum: 1024, maximum: 65535 })),
}, { additionalProperties: false });
export type ProxyAccess = Static<typeof proxyAccessSchema>;
export function validateProxyAccess(value: ProxyAccess): ProxyAccess {
  if (!Value.Check(proxyAccessSchema, value)) throw new Error("Invalid proxy access configuration");
  const url = new URL(value.origin);
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== value.origin || url.username || url.password || url.hostname.startsWith("[")) throw new Error("Use a canonical HTTP(S) public origin with a DNS hostname or IPv4 address, without a path or credentials");
  if (value.previewPorts.end < value.previewPorts.start || (Number(url.port) >= 41000 && Number(url.port) <= 41999)) throw new Error("Invalid proxy preview port range or UI port");
  if (value.adminPort && ([2999, 3000, 3001, 3080, 3081, 3082, 24800].includes(value.adminPort) || value.adminPort >= 41000 && value.adminPort <= 41999)) throw new Error("Reserved proxy admin port");
  return value;
}
export function proxyPreviewOrigin(config: ProxyAccess, port: number): string {
  if (!Number.isInteger(port) || port < config.previewPorts.start || port > config.previewPorts.end) throw new Error("Preview port is outside the configured proxy range");
  const url = new URL(config.origin); url.port = String(port); return url.origin;
}
