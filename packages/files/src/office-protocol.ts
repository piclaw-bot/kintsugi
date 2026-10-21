import type { JsonValue } from "@kintsugi/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { maxOfficeFileBytes, type OfficeKind } from "./office-format.ts";
export const officeThemeTokens = ["--bg", "--panel", "--elev", "--danger", "--danger-soft", "--text", "--text-bright", "--text-muted", "--line", "--line-strong", "--accent", "--font-mono", "--text-code"];
export interface OfficeLoadMessage { type: "office-load"; nonce: string; kind: OfficeKind; name: string; bytes: ArrayBuffer; theme: Record<string, string> }
export interface OfficeStatusMessage { type: "office-status"; phase: "ready" | "error"; message: string }
export interface OfficeReadyMessage { type: "office-ready"; nonce: string }
export type OfficeWireMessage = JsonValue | OfficeLoadMessage | OfficeStatusMessage | OfficeReadyMessage | ArrayBuffer | Record<string, JsonValue | ArrayBuffer>;
const nonce = Type.String({ pattern: "^[a-f0-9-]{36}$" });
const loadSchema = Type.Object({
  type: Type.Literal("office-load"), nonce,
  kind: Type.Union(["docx", "xlsx", "xlsm", "xlsb", "xls", "ods", "pptx", "csv", "tsv"].map(kind => Type.Literal(kind))),
  name: Type.String({ maxLength: 256 }), bytes: Type.Unknown(),
  theme: Type.Record(Type.String({ pattern: `^(${officeThemeTokens.join("|")})$` }), Type.String({ maxLength: 256 }), { additionalProperties: false, maxProperties: officeThemeTokens.length }),
}, { additionalProperties: false });
const readySchema = Type.Object({ type: Type.Literal("office-ready"), nonce }, { additionalProperties: false });
const statusSchema = Type.Object({ type: Type.Literal("office-status"), phase: Type.Union([Type.Literal("ready"), Type.Literal("error")]), message: Type.String({ maxLength: 1000 }) }, { additionalProperties: false });
export function parseOfficeLoadMessage(value: OfficeWireMessage): OfficeLoadMessage | undefined {
  if (!Value.Check(loadSchema, value) || !(value.bytes instanceof ArrayBuffer) || value.bytes.byteLength > maxOfficeFileBytes) return;
  // SAFETY: The schema restricts kind to the closed OfficeKind set; bytes are checked separately.
  return value as OfficeLoadMessage;
}
export function parseOfficeReadyMessage(value: OfficeWireMessage) { return Value.Check(readySchema, value) ? value : undefined; }
export function parseOfficeStatusMessage(value: OfficeWireMessage): OfficeStatusMessage | undefined { return Value.Check(statusSchema, value) ? value : undefined; }
