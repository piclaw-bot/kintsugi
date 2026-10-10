import { ensureSharedHome } from "../home.ts";
import { fileURLToPath } from "node:url";
import { prepareWorkspaceToolsMount } from "./workspace-tools.ts";
import { syncWorkspaceDocs } from "./workspace-docs.ts";
import {
  kintsugiDataPath,
  dockerHostKintsugiDataPath,
  getKintsugiRuntimeContext,
} from "@kintsugi/core";
import type { WorkspaceModule } from "@kintsugi/shared";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const docsMountPath = "/opt/kintsugi/docs";

export const kintsugiServerModule: WorkspaceModule = {
  id: "workspace",
  async initialize({ events }) {
    await ensureSharedHome();
    const runtime = getKintsugiRuntimeContext();
    await syncWorkspaceDocs(repositoryRoot, kintsugiDataPath(runtime, "docs"));
    const toolsMount = await prepareWorkspaceToolsMount(runtime);
    events.on("workspace_plan_prepare", ({ plan }) => {
      plan.mounts.push(toolsMount);
      if (plan.mounts.some((mount) => mount.target === docsMountPath)) return;
      plan.mounts.push({
        type: "bind",
        source: dockerHostKintsugiDataPath(runtime, "docs"),
        target: docsMountPath,
        readonly: true,
      });
    });
  },
};
