import { listWorkspaces } from "@kintsugi/workspace";
import type { WorkspaceModule } from "@kintsugi/shared";
import { ensureWorkspaceEgressProxy, registerWorkspaceProxyEvents } from "../egress/egress-proxy.ts";

export const proxyEgressServerModule: WorkspaceModule = {
  id: "proxy-egress",
  async initialize(context) {
    registerWorkspaceProxyEvents(context.events);
    for (const workspace of (await listWorkspaces({ inspectImages: false })).workspaces) await ensureWorkspaceEgressProxy(workspace.id);
  },
};

export { proxyEgressServerModule as kintsugiServerModule };
export {
  registerWorkspaceSubscriptionSecrets,
  registerWorkspaceRequestTransform,
  registerWorkspaceResponseTransform,
  clearGitHubToken,
  createWorkspaceSecretContext,
  discoverGitHubToken,
  hasGitHubToken,
  setGitHubToken,
} from "../secrets/workspace-secrets.ts";
export { HttpRequestBlockedError } from "../secrets/errors.ts";

export type { SecretRequestTransform } from "../secrets/placeholder-hooks.ts";
