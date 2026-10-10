import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseModelRef } from "@kintsugi/llm/server";
import { invalidArguments, readJsonObject, requestAcceptsJson } from "@kintsugi/core";
import { expandSlashCommand } from "@kintsugi/agent/server/slash-command-input";
import { listFileCompletions, renderFileCompletionMenu } from "@kintsugi/agent/server/file-completions";
import { runAgentNameCommand } from "@kintsugi/agent/server/agent-name-command";
import { suggestAgentSlug } from "@kintsugi/agent/server/slug-suggestion";
import { agentAttachmentDraftId, deliverAttachmentDraft, removeStagedAttachments } from "@kintsugi/prompt/server";
import { findTranscriptItem } from "@kintsugi/agent/server/transcript";
import { renderModelContextDetailFrame, renderTranscriptItemDetailFrame } from "@kintsugi/agent/server/render-transcript";
import { response, textResponse } from "@kintsugi/shared/http";
import { turboStream, workspaceModuleModalFrameId, turboStreamResponse } from "@kintsugi/shared";
import { nativeImageResponse } from "@kintsugi/cli-agent/server";
import type { CodexAgents } from "./runtime.ts";
import { parseCodexCommand } from "./commands.ts";
import { renderCommandDialog } from "./render-command.ts";
import { renderContext, transcriptItems } from "./render.ts";

export function codexRoutes(agents: CodexAgents) {
  return async (request: Request, url: URL): Promise<Response | undefined> => {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/codex-agents\/([^/]+)\/(.+)$/);
    if (!match) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const agentId = decodeURIComponent(match[2]!);
    const operation = match[3]!;
    const runtime = await agents.ready(workspaceId, agentId);
    const json = request.method === "POST" && requestAcceptsJson(request) ? await readJsonObject(request) : undefined;
    const form = request.method === "POST" && !json ? await request.formData() : undefined;
    const value = (key: string) => json?.[key] ?? form?.get(key);
    const success = (accepted = false, headers: Record<string, string> = {}) => json
      ? Response.json({ agent: { agentId, state: runtime.isBusy ? "running" : "idle" } }, { status: accepted ? 202 : 200, headers })
      : turboStreamResponse("", { headers });
    if ((operation === "messages" || operation === "commands") && request.method === "POST") {
      const argument = String(value("argument") ?? "").trim();
      const text = [String(value("text") ?? ""), argument].filter(Boolean).join(" ");
      const command = parseCodexCommand(text);
      if (command) {
        const requestId = value("requestId") ?? crypto.randomUUID();
        if (!Value.Check(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,128}$" }), requestId)) throw invalidArguments("Invalid request ID");
        if (command.kind === "resume" && !command.threadId && value("cursor") != null) {
          const cursor = value("cursor");
          if (!Value.Check(Type.String({ maxLength: 10000 }), cursor)) throw invalidArguments("Invalid conversation cursor");
          command.cursor = cursor;
        }
        if (command.kind === "skills" && command.name && value("skillPath") != null) {
          const path = value("skillPath");
          if (!Value.Check(Type.String({ maxLength: 4096 }), path)) throw invalidArguments("Invalid skill path");
          command.path = path;
        }
        const result = await runtime.command(command, requestId);
        return json ? Response.json({ agent: { agentId, state: runtime.isBusy ? "running" : "idle" }, command: result }, { status: result.kind === "done" ? 202 : 200 })
          : turboStreamResponse(turboStream("update", workspaceModuleModalFrameId, result.kind === "done" ? "" : renderCommandDialog(runtime, result)));
      }
      if (operation === "commands") throw invalidArguments("Choose a Codex command");
    }
    if (operation === "messages" && request.method === "POST") {
      const text = String(value("text") ?? "");
      if (text.trim() === "/new") { await runtime.reset(); return success(); }
      if (text.trim() === "/park") return new Response(null, { status: 307, headers: { Location: `/workspaces/${encodeURIComponent(workspaceId)}/park` } });
      const named = await runAgentNameCommand(text, {
        suggest: () => suggestAgentSlug(runtime.state.turns.flatMap(turn => turn.items).filter(item => item.type === "userMessage").flatMap(item => item.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n\n"), runtime.record.model ? parseModelRef(runtime.record.model) : undefined),
        setTitle: title => runtime.rename(title),
      });
      if (named) { if (named === "no-title") throw invalidArguments("Send a prompt before asking for an Agent name"); return success(); }
      const requestId = value("requestId") ?? crypto.randomUUID();
      if (!Value.Check(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,128}$" }), requestId)) throw invalidArguments("Invalid request ID");
      const draft = agentAttachmentDraftId(workspaceId, agentId);
      if (form && value("attachmentDraft") !== draft) throw invalidArguments("Invalid attachment draft");
      const consumedHeaders = { "x-kintsugi-attachment-draft-consumed": "true" };
      // A lost response after attachment removal must not cause a second delivery.
      if (form && runtime.record.submissions.some(item => item.id === requestId && item.accepted)) return success(true, consumedHeaders);
      const attachmentIds = form?.getAll("attachment").map(String) ?? [];
      const attachments = await deliverAttachmentDraft(workspaceId, draft, attachmentIds);
      const expanded = await expandSlashCommand(workspaceId, text);
      if (!expanded.trim() && !attachments.images.length && !attachments.attachmentNotes.length) throw invalidArguments("Write a prompt or attach a file");
      await runtime.send({ text: expanded, ...attachments }, requestId);
      await removeStagedAttachments(draft, attachmentIds);
      return success(true, consumedHeaders);
    }
    if (operation === "abort" && request.method === "POST") { await runtime.stop(); return success(); }
    if (operation === "model" && request.method === "POST") { await runtime.configure({ model: String(value("model") ?? "") }); return success(); }
    if (operation === "thinking-level" && request.method === "POST") { await runtime.configure({ thinkingLevel: String(value("thinkingLevel") ?? "") }); return success(); }
    if (operation === "completions" && request.method === "GET") return response(renderFileCompletionMenu(await listFileCompletions(workspaceId, url.searchParams.get("q") ?? "", url.searchParams.get("mode") === "fuzzy" ? "fuzzy" : "direct")));
    if (operation === "completions/slash-command-expand" && request.method === "POST") {
      const text = String(value("text") ?? "");
      return textResponse(parseCodexCommand(text) ? text.trim() : await expandSlashCommand(workspaceId, text));
    }
    if (operation.startsWith("transcript-items/") && request.method === "GET") {
      const key = decodeURIComponent(operation.slice("transcript-items/".length));
      const ctx = renderContext(runtime);
      if (key === "system-prompt") return response(renderModelContextDetailFrame(ctx, { systemPrompt: runtime.instructions, tools: [] }, key));
      const item = findTranscriptItem(transcriptItems(runtime), key);
      if (!item) return new Response("Transcript item not found", { status: 404 });
      const count = Number(url.searchParams.get("count") ?? 100);
      if (!Number.isInteger(count) || count < 1 || count > 10000) throw invalidArguments("Invalid transcript detail size");
      return response(renderTranscriptItemDetailFrame(ctx, item, { count }));
    }
    if (operation.startsWith("reveal/") && request.method === "GET") {
      const key = decodeURIComponent(operation.slice("reveal/".length));
      const section = transcriptItems(runtime).find(item => item.type === "working" && findTranscriptItem(item.items, key));
      return Response.json({ turnId: section?.key ?? null });
    }
    if (operation.startsWith("session-images/") && request.method === "GET") {
      const [, itemId, index] = operation.split("/");
      const item = runtime.state.turns.flatMap(turn => turn.items).find(item => item.id === decodeURIComponent(itemId!));
      if (item?.type !== "userMessage") return new Response("Image not found", { status: 404 });
      const part = item.content[Number(index)];
      if (part?.type !== "image" || !("url" in part)) return new Response("Image not found", { status: 404 });
      const data = part.url.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/);
      if (!data) return new Response("Image unavailable", { status: 404 });
      return nativeImageResponse(data[2]!, data[1]!);
    }
    return new Response("Not found", { status: 404 });
  };
}
