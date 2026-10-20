import { Type } from "typebox";
import { getWorkspaceInit } from "@kintsugi/workspace";
import { workspaceTemplateIdOfInit, grantedInstanceCredentials } from "@kintsugi/workspace-templates";
import { defineWorkspaceTool } from "@kintsugi/agent/server/workspace-tool";

export function createCredentialCatalogueTool(workspaceId: string, loadInit = getWorkspaceInit) {
  return defineWorkspaceTool({
    name: "list_credentials", label: "Available credentials",
    description: "List only instance credentials granted to this workspace's template. Returns descriptions, permitted HTTPS hosts, environment variable names and opaque placeholders, never real secrets. Use a placeholder in a request header to a permitted host. New grants can be used via the placeholder immediately; environment variables appear in newly created workspaces. This tool cannot grant, change or reveal credentials.",
    parameters: Type.Object({}),
    async execute() {
      const credentials = (await grantedInstanceCredentials(workspaceTemplateIdOfInit(await loadInit(workspaceId)))).map(({ name, envName, description, type, hostPattern, allowInPath, placeholder }) => ({ name, envName, description, type, hosts: hostPattern.split(","), allowInPath, placeholder }));
      return { content: [{ type: "text" as const, text: JSON.stringify({ credentials }) }], details: { count: credentials.length } };
    },
  });
}
