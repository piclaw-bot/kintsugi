import type { JsonValue } from "@earendil-works/chord";
import { defineEntry, type Extension, type JsonObject, type NestedToolExecutionResult } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { err, FileError, ok, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isJsonObject } from "@kintsugi/core";
import { execWorkspaceCommand } from "@kintsugi/workspace";

const textSchema = Type.String();
/** A tool with a structured output schema whose value carries its output, such as bash's. */
const outputValueSchema = Type.Object({ output: Type.String() });
/** A schema-less tool's output with several items; images are not text. */
const contentListSchema = Type.Array(Type.Union([Type.Object({ type: Type.Literal("text"), text: Type.String() }), Type.Object({ type: Type.String() })]));
const imageBlockSchema = Type.Object({ type: Type.Literal("image"), data: Type.String() });
/** Larger arguments are left out of a call's record. */
const maxRecordedArgumentsChars = 64 * 1024;

export type CallStart = { phase: "start"; name: string; arguments?: JsonValue };
export type CallEnd = { phase: "end"; isError: boolean; cancelled: boolean; durationMs?: number; output?: string; error?: string; details?: JsonObject };

/**
 * One call a code mode script made, recorded when it starts and when it ends. A bookkeeping entry
 * without model payload, so it follows branches and survives the script being stopped, unlike the
 * script's own result, which lists no results and, for a stopped script, no calls. `callId` is the
 * code mode call's, `key` the nested call's.
 */
export type CodemodeCallRecord = { callId: string; key: string } & (CallStart | CallEnd);
export const codemodeCallEntry = defineEntry<CodemodeCallRecord>("kintsugi.codemode-call");

/** A value as JSON for people to read: image data, which is long and unreadable, shows as its length. */
function displayJson(value: JsonValue, indent?: number): string {
  return JSON.stringify(value, (_key: string, item: JsonValue) => Value.Check(imageBlockSchema, item) ? { ...item, data: `${item.data.length} base64 characters` } : item, indent);
}

/** The text a nested call gave the script: its output, or the value it returned as JSON. */
function outputText(structuredOutput: NestedToolExecutionResult["structuredOutput"]): string | undefined {
  if (structuredOutput === undefined) return undefined;
  if (Value.Check(textSchema, structuredOutput)) return structuredOutput;
  if (Value.Check(outputValueSchema, structuredOutput)) return structuredOutput.output;
  if (Value.Check(contentListSchema, structuredOutput)) return structuredOutput.flatMap(item => "text" in item ? [item.text] : []).join("\n");
  return displayJson(structuredOutput, 2);
}

function callStart(name: string, args: JsonObject): CallStart {
  const json = displayJson(args);
  return json.length <= maxRecordedArgumentsChars ? { phase: "start", name, arguments: JSON.parse(json) } : { phase: "start", name };
}

function callEnd(result: NestedToolExecutionResult): CallEnd {
  const end: CallEnd = { phase: "end", isError: result.isError, cancelled: result.diagnostics.some(diagnostic => diagnostic.code === "aborted") };
  const output = outputText(result.structuredOutput);
  const error = result.diagnostics.filter(diagnostic => diagnostic.severity === "error").map(diagnostic => diagnostic.message).join("\n");
  if (result.durationMs !== undefined) end.durationMs = result.durationMs;
  if (output !== undefined) end.output = output;
  if (error) end.error = error;
  if (isJsonObject(result.details)) end.details = result.details;
  return end;
}

/**
 * Code mode saves the images a script shows to files, so the agent can use them later. It writes them
 * through the conversation's environment, which the builtin agent has none of: its tools reach the
 * workspace themselves. Give code mode alone one that writes the files into the workspace.
 */
function workspaceOutputFiles(workspaceId: string): Pick<ExecutionEnv, "createTempDir" | "writeFile"> {
  return {
    async createTempDir(prefix = "") {
      const result = await execWorkspaceCommand(workspaceId, ["mktemp", "-d", `/tmp/${prefix}XXXXXX`]);
      return result.exitCode === 0 ? ok(result.stdout.trim()) : err(new FileError("unknown", result.stderr.trim()));
    },
    async writeFile(path, content) {
      const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", 'cat > "$1"', "sh", path], { stdin: content });
      return result.exitCode === 0 ? ok(undefined) : err(new FileError("unknown", result.stderr.trim(), path));
    },
  };
}

/** The code mode extension, with its tool saving script output files in the workspace and recording each call its scripts make. */
export function createWorkspaceCodemodeExtension(workspaceId: string, sandbox: CodemodeSandbox): Extension {
  const extension = createCodemodeExtension({ sandbox });
  // SAFETY: code mode uses only createTempDir and writeFile of its environment.
  const env = workspaceOutputFiles(workspaceId) as ExecutionEnv;
  return { ...extension, tools: extension.tools?.map(tool => tool.name !== CODEMODE_TOOL_NAME ? tool : {
    ...tool,
    execute: (args, api, context) => tool.execute(args, {
      ...api, env,
      async executeTool(name, toolArgs, callContext, options) {
        // Code mode names each call `c<VM call id>`, so a rerun after a restart reattaches to it.
        const key = options?.key;
        if (key === undefined) throw new Error("Code mode calls tools by key");
        const record = (data: CallStart | CallEnd) => api.commit(async tx => {
          await tx.appendEntry(codemodeCallEntry, api.conversationId, { data: { callId: api.callId, key, ...data } });
        }, callContext);
        await record(callStart(name, toolArgs));
        const result = await api.executeTool(name, toolArgs, callContext, options);
        await record(callEnd(result));
        return result;
      },
    }, context),
  }) };
}
