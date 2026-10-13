import { shellQuote } from "@kintsugi/core";
import { execWorkspaceCommand, workspaceRoot } from "@kintsugi/workspace";

export async function loadWorkspaceAgentsFiles(workspaceId: string, { includeRoot = true }: { includeRoot?: boolean } = {}): Promise<Array<{ path: string; content: string }>> {
  const agentsPaths = [`${workspaceRoot}/.agents-in-the-cloud/AGENTS.md`, `${workspaceRoot}/.kintsugi/AGENTS.md`];
  if (includeRoot) agentsPaths.unshift(`${workspaceRoot}/AGENTS.md`);
  const agentsFiles: Array<{ path: string; content: string }> = [];

  for (const path of agentsPaths) {
    const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", `if test -s ${shellQuote(path)}; then cat ${shellQuote(path)}; fi`], { workdir: workspaceRoot });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `could not read ${path}`);
    if (result.stdout.trim()) agentsFiles.push({ path, content: result.stdout });
  }

  return agentsFiles;
}

export function formatProjectInstructions(file: { path: string; content: string }): string {
  return `# Project instructions: ${file.path}\n\n${file.content}`;
}
