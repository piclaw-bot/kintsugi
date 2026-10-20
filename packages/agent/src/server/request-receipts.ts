const checkers = new Map<string, (workspaceId: string, agentId: string, requestId: string) => Promise<boolean | undefined>>();
/** A checker returns undefined for Agent kinds it does not own. Checking never submits input. */
export function registerAgentRequestReceiptChecker(kind: string, check: (workspaceId: string, agentId: string, requestId: string) => Promise<boolean | undefined>): void { checkers.set(kind, check); }
export async function agentRequestWasAccepted(workspaceId: string, agentId: string, requestId: string): Promise<boolean | undefined> {
  for (const check of checkers.values()) { const accepted = await check(workspaceId, agentId, requestId); if (accepted !== undefined) return accepted; }
  return undefined;
}
