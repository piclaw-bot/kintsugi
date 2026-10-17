import { ModelToolUsage } from "./durable-model-tool-usage.ts";
import type { Usage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UsageDoc, type Harness } from "@earendil-works/pi-durable";
import { tokenTelemetry, type TelemetryCounter } from "@kintsugi/llm/server";
import { WorkspaceAgents } from "./durable-workspace.ts";

/** UsageDoc starts empty on forks; it includes compaction attempts and nested model-tool charges exactly once. */
export async function registerDurableTelemetry(harness: Harness, workspaceId: string) {
  return tokenTelemetry().register({
    id: `builtin:${workspaceId}`,
    async read() {
      const agents = (await harness.snapshot(WorkspaceAgents, BACKGROUND_CONTEXT))?.agents ?? [];
      const branches = new Set(agents.flatMap(agent => agent.branches ?? [agent.durableId]));
      const counters: TelemetryCounter[] = [];
      for (const branch of branches) {
        const usage = await harness.snapshot(UsageDoc, branch, BACKGROUND_CONTEXT);
        const collect = (bucket: "models" | "model-tools", totals: Record<string, Usage>) => {
          for (const [key, value] of Object.entries(totals)) {
            const slash = key.indexOf("/");
            if (slash <= 0 || slash === key.length - 1) throw new Error("Native token usage bucket lacks provider/model identity.");
            counters.push({ id: `${branch}:${bucket}:${key}`, provider: key.slice(0, slash), model: key.slice(slash + 1), usage: {
              input: value.input, output: value.output, cache_read: value.cacheRead, cache_write: value.cacheWrite,
              reasoning: value.reasoning, total: value.totalTokens, cost: value.cost.total,
            } });
          }
        };
        collect("models", usage?.models ?? {});
        collect("model-tools", (await harness.snapshot(ModelToolUsage, branch, BACKGROUND_CONTEXT))?.models ?? {});
      }
      return counters;
    },
  });
}
