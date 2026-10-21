// Module installation and lifecycle integration live here. Transcript,
// presentation, and session helpers have dedicated package subpaths.
export { publishWorkspaceAgentBusy, subscribeWorkspaceAgentBusy } from "./workspace-agent-busy.ts";
export { agentWorkspaceModule, agentWorkspaceModule as kintsugiServerModule } from "./web.ts";
export { prepareCliAgentConnection, type CliAgentConnection, revokeAgentMcp, configureAgentMcp, handleAgentMcpRequest } from "./mcp.ts";
export { registerAgentTurnSettler, type AgentTurnFinishReason } from "./turn-lifecycle.ts";
export { registerAgentToolPresentations, type AgentToolPresentation } from "./tool-presentations.ts";
