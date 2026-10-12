import { createNativeAgentRoutes, type NativeAgents } from "@kintsugi/native-agent/server";
import { nativeImageResponse } from "@kintsugi/cli-agent/server";
import type { ClaudeRuntime } from "./runtime.ts";
import { parseClaudeCommand } from "./commands.ts";
import { renderCommandDialog } from "./render-command.ts";
import { rendering } from "./render.ts";
import { claudeImageSources, claudeText } from "./rows.ts";

export function claudeRoutes(agents: NativeAgents<ClaudeRuntime>) {
  return createNativeAgentRoutes(agents, rendering, {
    unknownCommand: "Choose a Claude Code command",
    parseCommand: parseClaudeCommand,
    runCommand: (runtime, command, { requestId }) => runtime.command(command, requestId),
    renderCommandDialog: (runtime, result) => result.kind === "done" ? "" : renderCommandDialog(runtime, result),
    promptText: runtime => runtime.state.rows.flatMap(row => row.kind === "user" && !row.meta && !row.content.some(block => block.type === "tool_result") ? [claudeText(row.content)] : []).join("\n\n"),
    delivered: (runtime, requestId) => runtime.record.submissions.some(item => item.id === requestId),
    isHarnessCommand: (runtime, text) => runtime.isClaudeCommand(text),
    sessionImage(runtime, entryId, index) {
      const row = runtime.state.rows.find(row => row.uuid === entryId);
      const source = row?.kind === "user" ? claudeImageSources(row.content)[index] : undefined;
      return source ? nativeImageResponse(source.data, source.media_type) : new Response("Image not found", { status: 404 });
    },
  });
}
