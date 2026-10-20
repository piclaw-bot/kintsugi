import { Type, type Static } from "typebox";

const fields = {
  name: Type.String({ minLength: 1, maxLength: 120 }),
  envName: Type.String({ pattern: "^[A-Z_][A-Z0-9_]*$", maxLength: 120 }),
  description: Type.String({ maxLength: 1000 }),
  type: Type.Union([Type.Literal("token"), Type.Literal("password"), Type.Literal("secret")]),
  hostPattern: Type.String({ minLength: 1, maxLength: 2000 }),
  allowInPath: Type.Boolean(),
  enabled: Type.Boolean(),
  templateIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 500, uniqueItems: true }),
};
export const instanceCredentialInputSchema = Type.Object({
  ...fields,
  expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
  secretValue: Type.Optional(Type.String({ minLength: 1, maxLength: 65536, writeOnly: true })),
}, { additionalProperties: false });
export type InstanceCredentialInput = Static<typeof instanceCredentialInputSchema>;
export const storedInstanceCredentialSchema = Type.Object({
  ...fields, id: Type.String(), revision: Type.Integer({ minimum: 1 }), encryptedSecret: Type.String(), createdAt: Type.String(), updatedAt: Type.String(),
  lastUsedAt: Type.Optional(Type.String()),
});
export type StoredInstanceCredential = Static<typeof storedInstanceCredentialSchema>;
export type InstanceCredentialSummary = Omit<StoredInstanceCredential, "encryptedSecret">;
export const credentialAuditSchema = Type.Object({
  credentialId: Type.String(), at: Type.String(),
  action: Type.Union([Type.Literal("created"), Type.Literal("updated"), Type.Literal("rotated"), Type.Literal("deleted")]),
});
