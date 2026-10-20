import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { withCommandSignal } from "@kintsugi/core";
import { execWorkspaceCommand, workspaceRoot } from "@kintsugi/workspace";
import { defineWorkspaceTool } from "./workspace-tool.ts";

const fields = {
  pattern: Type.String({ minLength: 1, maxLength: 4096, description: "AST pattern: $VAR matches one node, $$$VAR matches multiple nodes." }),
  lang: Type.String({ minLength: 1, maxLength: 40, pattern: "^[A-Za-z][A-Za-z0-9_+-]*$", description: "ast-grep language, such as typescript, javascript, tsx, python, rust, go, java or cpp." }),
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "File or directory inside /work; default is the workspace root. Ignore rules and symlink exclusions are preserved." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum returned matches, default 100." })),
};
export const codeSearchSchema = Type.Object(fields, { additionalProperties: false });
export const codeRewriteSchema = Type.Object({ ...fields,
  rewrite: Type.String({ maxLength: 8192, description: "Replacement pattern, with matched metavariables." }),
  dry_run: Type.Optional(Type.Boolean({ description: "Preview only by default. Set false to atomically apply one regular UTF-8 file (at most 1 MiB)." })),
  expected_revision: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$", description: "Required to apply: revision returned by a dry-run preview of that single file." })),
}, { additionalProperties: false });
type CodeInput = Static<typeof codeSearchSchema> & { rewrite?: string; dry_run?: boolean; expected_revision?: string };
const matchSchema = Type.Object({ file: Type.String({ maxLength: 4096 }), line: Type.Integer({ minimum: 1 }), column: Type.Integer({ minimum: 1 }), text: Type.String({ maxLength: 2000 }), replacement: Type.Optional(Type.String({ maxLength: 2000 })), textTruncated: Type.Boolean() }, { additionalProperties: false });
const successSchema = Type.Object({ ok: Type.Literal(true), dry_run: Type.Boolean(), applied: Type.Boolean(), revision: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })), truncated: Type.Boolean(), diagnostics: Type.String({ maxLength: 4000 }), matches: Type.Array(matchSchema, { maxItems: 100 }) }, { additionalProperties: false });
const failureSchema = Type.Object({ ok: Type.Literal(false), error: Type.String({ maxLength: 4000 }) }, { additionalProperties: false });

export async function runStructuralCode(workspaceId: string, input: CodeInput, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(20000);
  const scoped = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const result = await withCommandSignal(scoped, () => execWorkspaceCommand(workspaceId, ["/usr/local/bin/bun", "/opt/kintsugi/bin/kintsugi-code", "run", workspaceRoot, "/opt/kintsugi/ast-grep/ast-grep", "/opt/kintsugi/ast-grep/sgconfig.yml"], { stdin: JSON.stringify(input), maxOutputBytes: 131072 }));
  if (!result.stdout.trim()) throw new Error(result.stderr.trim() || "Structural code support is unavailable in this workspace image. Use an image containing the pinned ast-grep tool.");
  const output: unknown = JSON.parse(result.stdout);
  if (Value.Check(failureSchema, output)) throw new Error(output.error);
  if (!Value.Check(successSchema, output) || result.exitCode !== 0) throw new Error("Invalid structural code helper result");
  return { content: [{ type: "text" as const, text: JSON.stringify(output) }], details: { dryRun: output.dry_run, applied: output.applied, truncated: output.truncated, revision: output.revision } };
}
export function createCodeSearchTool(workspaceId: string) {
  return defineWorkspaceTool({ name: "code_search", label: "Code Search", description: "Search source by AST structure with pinned ast-grep, inside this workspace only. Metavariables: $VAR for one node, $$$VAR for several. Results use one-based line/column coordinates and are bounded to 100 matches / 30,000 characters. Respects ignore files; does not follow symlinks out of /work or load project native-language plugins. Search is read-only, with a 15-second parser deadline and 256 MiB parser address-space limit.", parameters: codeSearchSchema, execute: (_id, input, signal) => runStructuralCode(workspaceId, input, signal) });
}
export function createCodeRewriteTool(workspaceId: string) {
  return defineWorkspaceTool({ name: "code_rewrite", label: "Code Rewrite", description: "Preview structural find-and-replace with pinned ast-grep; dry_run defaults to true. Directory previews discover matches. To apply, preview one regular UTF-8 file (at most 1 MiB), then pass its revision as expected_revision with dry_run=false. Each apply replaces one file atomically and rejects stale source, overlapping edits or truncated results. For multi-file refactors, preview and apply each file separately. Never runs project configuration/plugins. An interrupted apply is not automatically replayed: inspect the file before retrying.", parameters: codeRewriteSchema, execute: (_id, input, signal) => runStructuralCode(workspaceId, input, signal) });
}
