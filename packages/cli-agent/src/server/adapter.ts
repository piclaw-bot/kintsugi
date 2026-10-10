import type { JsonObject } from "@kintsugi/core";
import type { CliAgentConnection } from "@kintsugi/agent/server";
import type { TranscriptRecord } from "@kintsugi/agent/server/transcript";
import type { AgentLaunchFooterContext, AgentWorkspaceParameters, WorkspaceAgentInput } from "@kintsugi/shared";

/** Identity of the session being launched, so adapters can address their session-local files. */
export interface CliAgentSession {
  id: string;
  /** Existing session-private directory (umask 077) for the adapter's configuration files. */
  directory: string;
  /** Script the CLI must run at each turn boundary, already authorized for this session. */
  turnSignalCommand: string;
}

/** Provider-specific policy; the shared module owns sessions and terminal presentation. */
export interface CliAgentAdapter {
  /** Stable slug: also owns <id>-agents.json, <id>-agents routes and tmux names. */
  id: string;
  label: string;
  iconHtml: string;
  requireSetup(): Promise<void>;
  settings: {
    renderFooter(context: AgentLaunchFooterContext): Promise<string>;
    prepare(parameters?: JsonObject): Promise<AgentWorkspaceParameters>;
  };
  /** Refresh workspace configuration before a new or restored terminal launch. */
  prepareWorkspace?(workspaceId: string): Promise<void>;
  /** Install full instructions through the native prompt and session-local MCP config. Returned environment is terminal-local. */
  prepareSession(workspaceId: string, session: CliAgentSession, connection: CliAgentConnection): Promise<Record<string, string>>;
  /** Bash script with the CLI-specific flags and initial prompt. */
  launchScript(input: WorkspaceAgentInput, imagePaths: string[], settings: AgentWorkspaceParameters, session: CliAgentSession): string;
  /** Restore native context without submitting any prompt; an empty session opens idle. */
  resumeScript?(workspaceId: string, settings: AgentWorkspaceParameters, session: CliAgentSession): Promise<string>;
  /** Optional native-history adapter. CLI Agent types without one remain terminal-only. */
  loadTranscript?(workspaceId: string, sessionId: string): Promise<TranscriptRecord[] | undefined>;
  /** Whether native history holds all of the last finished turn; turn signals can precede the CLI's final writes. */
  turnSettled?(workspaceId: string, sessionId: string): Promise<boolean>;
  /** Native conversation files to publish to the session share; never config or credentials. */
  historyFiles?(workspaceId: string, sessionId: string): Promise<string[]>;
  loadTranscriptImage?(workspaceId: string, sessionId: string, entryId: string, contentIndex: number): Promise<Response>;
}
