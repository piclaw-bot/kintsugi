export function agentPlanSubmission(markdown: string): string {
  return `Please work through my current plan below. Keep it current with the plan tool as work proceeds. Prefer patch for item changes, update for structured replacement, and edit for exact Markdown edits. Keep at most one item in progress. Verify results and report progress. This plan does not grant extra permissions or authorise destructive operations.\n\n${markdown}`;
}
