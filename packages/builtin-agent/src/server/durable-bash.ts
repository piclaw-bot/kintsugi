import { defineDoc, defineExtension, defineTask, defineTool, type TaskId } from "@earendil-works/pi-durable";
import { execWorkspaceCommand, workspaceRoot } from "@kintsugi/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { bashToolDefinition, forcedColorEnvironment, formatBashOutput } from "@kintsugi/agent/server/bash-tmux";

export type BashOperationRequest = {
  id: string;
  command: string;
  deadline: number;
  cwd: string;
  env: Record<string, string>;
};

export const bashOperationReceiptSchema = Type.Union([
  Type.Object({ status: Type.Literal("running"), session: Type.String() }),
  Type.Object({ status: Type.Literal("uncertain"), message: Type.String() }),
  Type.Object({
    status: Type.Literal("done"), exitCode: Type.Union([Type.Number(), Type.Null()]),
    aborted: Type.Boolean(), timedOut: Type.Boolean(), output: Type.String(), displayAnsi: Type.String(), fullOutputPath: Type.String(),
  }),
]);
type BashOperationReceipt = Static<typeof bashOperationReceiptSchema>;
type BashOperationAction = "ensure" | "status" | "stop";
export type BashOperations = (action: BashOperationAction, request: BashOperationRequest, create?: boolean) => Promise<BashOperationReceipt>;

function workspaceBashOperations(workspaceId: string): BashOperations {
  return async (action, request, create = false) => {
    const command = ["/opt/kintsugi/bin/kintsugi-agent-bash", action, JSON.stringify(request)];
    if (create) command.push("--create");
    // Do not pass the host's invocation signal: it must not own the workspace
    // command lifetime. These are short receipt operations, not command waits.
    const result = await execWorkspaceCommand(workspaceId, command);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not access the workspace command receipt");
    return Value.Parse(bashOperationReceiptSchema, JSON.parse(result.stdout));
  };
}

type BashInput = { request: BashOperationRequest; timeout: number };
type BashCheckpoint = { phase: "execute" };
const BashChild = defineDoc<{ id: TaskId<BashOperationReceipt> | null }>({
  kind: "kintsugi.bash-child", version: 1, scope: "task", initial: () => ({ id: null }),
});

/** Install the tool AND its owned task together. The task's abort protocol owns Stop. */
export function createDurableBashExtension(workspaceId: string, operations: BashOperations = workspaceBashOperations(workspaceId)) {
  const operation = defineTask<BashInput, BashCheckpoint, BashOperationReceipt>({
    name: "kintsugi.bash-operation", version: 1,
    initial: () => ({ phase: "execute" }),
    phases: {
      async execute(task, runtime, context) {
        // Only this first invocation can create a missing workspace receipt.
        // If it dies before admission, a retry reports uncertainty rather than
        // guessing whether a missing receipt means a command never ran.
        const invocation = crypto.randomUUID();
        const first = await runtime.memo("launch-invocation", invocation, context);
        let receipt = await operations("ensure", task.input.request, first === invocation);
        while (receipt.status === "running") {
          await runtime.sleep(runtime.now() + 350, context);
          receipt = await operations("status", task.input.request);
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: receipt } }), context);
      },
    },
    async abort(task, runtime, context) {
      // Host close cancels a run invocation, but never invokes this protocol.
      // A durable abort mark does: Stop is retried after restart until acknowledged.
      let receipt = await operations("stop", task.input.request);
      while (receipt.status === "running") {
        await runtime.sleep(runtime.now() + 100, context);
        receipt = await operations("status", task.input.request);
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: receipt, reason: receipt.status === "uncertain" ? receipt.message : "Stopped by user" } }), context);
    },
  });
  const bash = defineTool({
    ...bashToolDefinition,
    // Safe means reattach to our receipt, NOT execute an arbitrary command again.
    replay: "safe",
    async execute(args, api, context) {
      const child = await api.commit(async (tx) => {
        const binding = await tx.doc(BashChild, api.taskId);
        if (binding.id !== null) return binding.id;
        const timeout = Math.max(1, args.timeout ?? 600);
        const request: BashOperationRequest = {
          id: crypto.randomUUID(), command: args.command, deadline: Date.now() + timeout * 1000, cwd: workspaceRoot,
          env: Object.fromEntries(Object.entries({
            ...forcedColorEnvironment, COLUMNS: 120, LINES: 30,
            EDITOR: "true", GIT_EDITOR: "true", VISUAL: "true", GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: 0,
          }).map(([key, value]) => [key, String(value)])),
        };
        binding.id = await tx.createTask(operation, { request, timeout }, { ownership: { kind: "task", taskId: api.taskId } });
        return binding.id;
      }, context);
      const record = (await api.getTask(child, context))!;
      // SAFETY: this ID is atomically bound above to our version-1 operation task and its BashInput.
      const input = record.input as BashInput;
      await api.details({ workspaceId, tmuxSession: `kintsugi-agent-${input.request.id}`, command: input.request.command }, context);
      const settled = await api.waitForTask(child, context);
      if (settled.state.outcome.status === "faulted" || settled.state.outcome.status === "failed") throw new Error(settled.state.outcome.error.message);
      if (settled.state.outcome.status !== "completed") throw new Error(`Command operation ${settled.state.outcome.status}`);
      const receipt = settled.state.outcome.result;
      if (receipt.status === "running") throw new Error("Command operation completed without a terminal receipt");
      if (receipt.status === "uncertain") return { isError: true, output: [{ type: "text", text: receipt.message }] };
      const formatted = formatBashOutput(receipt.output, receipt.displayAnsi, receipt.fullOutputPath);
      let text = formatted.output || "(no output)";
      if (receipt.aborted) text += "\n\nCommand aborted";
      else if (receipt.timedOut) text += `\n\nCommand timed out after ${input.timeout} seconds`;
      else if (receipt.exitCode !== 0) text += `\n\nCommand exited with code ${receipt.exitCode}`;
      return {
        output: [{ type: "text", text }],
        details: { workspaceId, exitCode: receipt.exitCode, displayAnsi: formatted.displayAnsi, aborted: receipt.aborted,
          timedOut: receipt.timedOut, fullOutputPath: receipt.fullOutputPath },
      };
    },
  });
  return defineExtension({ name: "kintsugi.bash", tools: [bash], tasks: [operation] });
}
