import { posix } from "node:path";
import { invalidArguments } from "@kintsugi/core";
import { openFileInFiles } from "@kintsugi/files/server";
import type { WorkspaceFileTarget, WorkspaceModuleRouteContext } from "@kintsugi/shared";
import { listWorkspaceVSCodeViews, openFileInVSCode } from "@kintsugi/vscode/server";
import { existingFilesInWorkspace, workspaceRoot } from "@kintsugi/workspace";

export async function openWorkspaceFile(workspaceId: string, target: WorkspaceFileTarget, openWorkView: WorkspaceModuleRouteContext["openWorkView"], requireExisting = false): Promise<Response> {
  const path = posix.resolve(workspaceRoot, target.path);
  if (path === workspaceRoot) throw invalidArguments("Choose a file to open");
  if (requireExisting) {
    // Plain terminal paths are only guesses; do not create a tab for an
    // example, nonexistent proposal, or directory.
    if ((await existingFilesInWorkspace(workspaceId, "agent", [path])).length === 0) return new Response(null, { status: 204 });
  }
  const resolvedTarget = { ...target, path };
  const vscode = listWorkspaceVSCodeViews(workspaceId)[0];
  return vscode
    ? openFileInVSCode(workspaceId, vscode.title, resolvedTarget, openWorkView)
    : openFileInFiles(workspaceId, resolvedTarget, openWorkView);
}
