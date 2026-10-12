import { Type } from "typebox";
import { Value } from "typebox/value";
import { invalidArguments } from "@kintsugi/core";
import { createNativeAgentRoutes, type NativeAgents } from "@kintsugi/native-agent/server";
import { nativeImageResponse } from "@kintsugi/cli-agent/server";
import type { CodexRuntime } from "./runtime.ts";
import { parseCodexCommand } from "./commands.ts";
import { renderCommandDialog } from "./render-command.ts";
import { rendering } from "./render.ts";

export function codexRoutes(agents: NativeAgents<CodexRuntime>) {
  return createNativeAgentRoutes(agents, rendering, {
    unknownCommand: "Choose a Codex command",
    parseCommand: parseCodexCommand,
    runCommand(runtime, command, { requestId, field }) {
      if (command.kind === "resume" && !command.threadId && field("cursor") != null) {
        const cursor = field("cursor");
        if (!Value.Check(Type.String({ maxLength: 10000 }), cursor)) throw invalidArguments("Invalid conversation cursor");
        command.cursor = cursor;
      }
      if (command.kind === "skills" && command.name && field("skillPath") != null) {
        const path = field("skillPath");
        if (!Value.Check(Type.String({ maxLength: 4096 }), path)) throw invalidArguments("Invalid skill path");
        command.path = path;
      }
      return runtime.command(command, requestId);
    },
    renderCommandDialog: (runtime, result) => result.kind === "done" ? "" : renderCommandDialog(runtime, result),
    promptText: runtime => runtime.state.turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage").flatMap(item => item.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n\n"),
    delivered: (runtime, requestId) => runtime.record.submissions.some(item => item.id === requestId && item.accepted),
    newConversation: runtime => runtime.reset(),
    sessionImage(runtime, itemId, index) {
      const item = runtime.state.turns.flatMap(turn => turn.items).find(item => item.id === itemId);
      if (item?.type !== "userMessage") return new Response("Image not found", { status: 404 });
      const part = item.content[index];
      if (part?.type !== "image" || !("url" in part)) return new Response("Image not found", { status: 404 });
      const data = part.url.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/);
      if (!data) return new Response("Image unavailable", { status: 404 });
      return nativeImageResponse(data[2]!, data[1]!);
    },
  });
}
