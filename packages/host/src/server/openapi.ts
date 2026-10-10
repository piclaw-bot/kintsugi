import type { JsonObject } from "@kintsugi/core";
const response = { "200": { description: "Host operation result. Use Accept: application/json for automation; the UI receives server-rendered HTML." } };
const origin = { name: "Origin", in: "header", required: true, schema: { type: "string" }, description: "Must equal the public Kintsugi origin. Required for privileged mutations and terminal WebSocket upgrades." };
const id = { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^host-[a-f0-9-]{36}$" } };
export const hostOpenApiPaths = {
  "/host": { get: { summary: "Inspect Host availability or open Host", description: "Host provides diagnostics and privileged terminals in Kintsugi System, outside individual Workspaces. It does not imply access to the physical machine running Docker.", responses: response } },
  "/host/sample": {
    get: { summary: "Read the last Host diagnostic sample; collect once if none exists", responses: response },
    post: { summary: "Collect a fresh, bounded Host diagnostic sample", parameters: [origin], responses: response },
  },
  "/host/terminals": {
    get: { summary: "List persistent Host terminal sessions", responses: response },
    post: { summary: "Create a persistent Host terminal running as root in Kintsugi System", parameters: [origin], responses: response },
  },
  "/host/terminals/{id}/terminate": { post: { summary: "Terminate a Host terminal and its processes (not merely detach)", parameters: [id, origin], responses: response } },
} satisfies Record<string, JsonObject>;
