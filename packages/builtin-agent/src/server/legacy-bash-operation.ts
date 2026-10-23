import { setTimeout as delay } from "node:timers/promises";
import { defineTask } from "@earendil-works/pi-durable";
import { execWorkspaceCommand } from "@kintsugi/workspace";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

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
type BashCheckpoint = {phase: "execute"};

/** Finish or stop pre-terminal-process calls without replaying their commands. */
export function createLegacyBashOperation(workspaceId: string, operations: BashOperations = workspaceBashOperations(workspaceId)) {
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
          await delay(350, undefined, { signal: context.abortSignal });
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
        await delay(100, undefined, { signal: context.abortSignal });
        receipt = await operations("status", task.input.request);
      }
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", result: receipt, reason: receipt.status === "uncertain" ? receipt.message : "Stopped by user" } }), context);
    },
  });
  return operation;
}
