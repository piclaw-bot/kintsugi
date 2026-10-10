import { dirname, posix } from "node:path";
import { shellQuote } from "@kintsugi/core";
import { execWorkspaceCommand, execWorkspaceCommandBuffer, execWorkspaceShell, workspaceRoot } from "@kintsugi/workspace";
import type { ReadToolOptions, WriteToolOptions, EditToolOptions } from "@earendil-works/pi-coding-agent";

export function normalizeWorkspacePath(path: string): string {
  if (!path || path.includes("\0")) throw new Error("path is required");
  const absolute = path.startsWith("/") ? posix.normalize(path) : posix.normalize(posix.join(workspaceRoot, path));
  return absolute;
}

const supportedImageMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"]);

async function detectWorkspaceImageMimeType(workspaceId: string, absolutePath: string): Promise<string | null> {
  const result = await execWorkspaceCommand(workspaceId, ["file", "--brief", "--mime-type", absolutePath]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `could not inspect ${absolutePath}`);
  const mimeType = result.stdout.trim().toLowerCase();
  return supportedImageMimeTypes.has(mimeType) ? mimeType : null;
}

async function readFileBuffer(workspaceId: string, absolutePath: string): Promise<Buffer> {
  const result = await execWorkspaceCommandBuffer(workspaceId, ["cat", absolutePath]);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `could not read ${absolutePath}`);
  return result.stdout;
}

async function writeFile(workspaceId: string, absolutePath: string, content: string): Promise<void> {
  const dir = dirname(absolutePath);
  const result = await execWorkspaceShell(workspaceId, `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(absolutePath)}`, { stdin: content });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `could not write ${absolutePath}`);
}

async function accessFile(workspaceId: string, absolutePath: string): Promise<void> {
  const result = await execWorkspaceCommand(workspaceId, ["test", "-r", absolutePath]);
  if (result.exitCode !== 0) throw new Error(`file is not readable: ${absolutePath}`);
}

export function workspaceFileToolOptions(workspaceId: string) {
  const read: ReadToolOptions = {
    operations: {
      readFile: (path) => readFileBuffer(workspaceId, normalizeWorkspacePath(path)),
      access: (path) => accessFile(workspaceId, normalizeWorkspacePath(path)),
      detectImageMimeType: (path) => detectWorkspaceImageMimeType(workspaceId, normalizeWorkspacePath(path)),
    },
  };
  const write: WriteToolOptions = {
    operations: {
      writeFile: (path, content) => writeFile(workspaceId, normalizeWorkspacePath(path), content),
      mkdir: async (path) => {
        const result = await execWorkspaceCommand(workspaceId, ["mkdir", "-p", normalizeWorkspacePath(path)]);
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `could not create ${path}`);
      },
    },
  };
  const edit: EditToolOptions = {
    operations: {
      readFile: (path) => readFileBuffer(workspaceId, normalizeWorkspacePath(path)),
      writeFile: (path, content) => writeFile(workspaceId, normalizeWorkspacePath(path), content),
      access: (path) => accessFile(workspaceId, normalizeWorkspacePath(path)),
    },
  };
  return { read, write, edit };
}
