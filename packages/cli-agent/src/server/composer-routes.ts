import { expandSlashCommand } from "@kintsugi/agent/server/slash-command-input";
import { listFileCompletions, renderFileCompletionMenu } from "@kintsugi/agent/server/file-completions";
import { runAgentNameCommand } from "@kintsugi/agent/server/agent-name-command";
import { agentAttachmentDraftId, copyAttachmentIntoWorkspace, findStagedAttachment, removeStagedAttachments } from "@kintsugi/prompt/server";
import { response, textResponse } from "@kintsugi/shared/http";
import type { CliAgents } from "./agents.ts";

export function cliComposerRoutes(providerId: string, agents: CliAgents) {
  return async (request: Request, url: URL): Promise<Response | undefined> => {
    const match = url.pathname.match(/^\/workspaces\/([^/]+)\/([^/]+)-agents\/([^/]+)\/composer(?:\/(completions(?:\/slash-command-expand)?|consumed))?$/);
    if (!match || match[2] !== providerId) return undefined;
    const workspaceId = decodeURIComponent(match[1]!);
    const agentId = decodeURIComponent(match[3]!);
    const operation = match[4] ?? "";
    const session = await agents.ready(workspaceId, agentId);
    if (request.method === "GET" && operation === "completions") {
      const html = renderFileCompletionMenu(await listFileCompletions(workspaceId, url.searchParams.get("q") ?? "", url.searchParams.get("mode") === "fuzzy" ? "fuzzy" : "direct"));
      return response(html);
    }
    if (request.method === "POST" && operation === "completions/slash-command-expand") {
      const form = await request.formData();
      return textResponse(await expandSlashCommand(workspaceId, String(form.get("text") ?? "")));
    }
    const draftId = agentAttachmentDraftId(workspaceId, `${providerId}:${agentId}`);
    if (request.method === "POST" && operation === "consumed") {
      const form = await request.formData();
      if (form.get("attachmentDraft") !== draftId) return new Response("Invalid draft", { status: 422 });
      await removeStagedAttachments(draftId, form.getAll("attachment").map(String));
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST" || operation) return undefined;
    if (session.error || (await agents.terminalState(workspaceId, session)).state !== "running") return new Response("Terminal unavailable", { status: 409 });
    const form = await request.formData();
    if (form.get("attachmentDraft") !== draftId) return new Response("Invalid draft", { status: 422 });
    const nameResult = await runAgentNameCommand(String(form.get("text") ?? ""), {
      suggest: () => agents.suggestTitle(workspaceId, agentId),
      setTitle: (title) => agents.setTitle(workspaceId, agentId, title),
    });
    if (nameResult) return nameResult === "named"
      ? new Response(null, { status: 204 })
      : new Response("No prompt available to name this Agent", { status: 422 });
    const ids = form.getAll("attachment").map(String);
    const attachments = await Promise.all(ids.map(async (id) => {
      const attachment = await findStagedAttachment(draftId, id);
      if (!attachment) throw new Error(`Attachment not found: ${id}`);
      return attachment;
    }));
    let text = await expandSlashCommand(workspaceId, String(form.get("text") ?? ""));
    if (!text.trim() && !attachments.length) return new Response("Enter a prompt or attach a file", { status: 422 });
    const notes: string[] = [];
    for (const attachment of attachments) {
      const path = `/tmp/kintsugi-attachments/${providerId}-${agentId}/${attachment.id}/${attachment.name}`;
      await copyAttachmentIntoWorkspace(workspaceId, attachment, path);
      notes.push(`[Attached ${attachment.isImage ? "image" : "file"} available at ${path}]`);
    }
    text = [text, ...notes].filter(Boolean).join("\n\n");
    await agents.recordNamingPrompt(workspaceId, agentId, text);
    return textResponse(text);
  };
}
