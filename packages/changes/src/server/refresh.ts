import type { Repository } from "@kintsugi/workspace/git";
import type { DiffEndpoints } from "../history.ts";
import { captureChanges, captureHistory, commitHistory, stagedChanges, workingTree, type ChangesSnapshot } from "./snapshot.ts";

/** Manual and turn-target refresh share the same endpoint-preservation rules. */
export async function refreshChanges(root: Repository, previous: ChangesSnapshot, requested = previous.endpoints): Promise<ChangesSnapshot> {
  const history = await captureHistory(root);
  let endpoints: DiffEndpoints = { ...requested };
  const initial = previous.history.endpoints;
  const followsDefault = endpoints.target === initial.target && endpoints.base === initial.base;
  if (followsDefault) endpoints = history.endpoints;
  if (!history.hasStaged) {
    if (endpoints.target === stagedChanges) endpoints = { target: workingTree };
    else if (endpoints.base === stagedChanges) endpoints.base = history.head ?? null;
  }
  while (history.hasMore && (!history.commits.some(commit => commit.id === endpoints.target) || (!followsDefault && endpoints.base != null && !history.commits.some(commit => commit.id === endpoints.base)))) {
    const page = await commitHistory(root, history, history.loaded);
    history.commits.push(...page.commits);
    history.loaded += page.commits.length;
    history.hasMore = page.hasMore;
  }
  // Amends, rebases and resets can drop the selected commits; show the default comparison instead.
  if (!history.commits.some(commit => commit.id === endpoints.target) || (endpoints.base != null && !history.topology.some(commit => commit.id === endpoints.base))) endpoints = history.endpoints;
  return captureChanges(root, endpoints, history);
}
