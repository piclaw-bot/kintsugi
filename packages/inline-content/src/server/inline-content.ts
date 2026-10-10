import { execWorkspaceCommand } from "@kintsugi/workspace";

export const inlineContentMaxBytes = 1024 * 1024;
export type InlineContentFragment = { html: string } | { error: string };

export function validateInlineContent(html: string): InlineContentFragment {
  if (Buffer.byteLength(html) > inlineContentMaxBytes) return { error: "This visual is too large. Ask the agent to keep it under 1 MiB." };
  if (!html.trim()) return { error: "The visual explanation file was empty." };
  if (/<\s*(?:!doctype|html\b|head\b|body\b)/i.test(html)) return { error: "This visual is a full page. Ask the agent to write an HTML fragment instead." };
  return { html };
}

export async function readInlineContent(workspaceId: string, path: string): Promise<InlineContentFragment> {
  const result = await execWorkspaceCommand(workspaceId, ["head", "-c", String(inlineContentMaxBytes + 1), "--", path]);
  if (result.exitCode !== 0) return { error: "The visual explanation file could not be read. Ask the agent to check the file, then reload." };
  return validateInlineContent(result.stdout);
}

