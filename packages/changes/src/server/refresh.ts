import type { Repository } from "@kintsugi/workspace/git";
import type { DiffEndpoints } from "../history.ts";
import { captureChanges, captureHistory, loadHistoryThrough, stagedChanges, workingTree, type ChangesSnapshot } from "./snapshot.ts";

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
  await loadHistoryThrough(root, history, [endpoints.target, followsDefault ? undefined : endpoints.base]);
  // Amends, rebases and resets can drop the selected commits; show the default comparison instead.
  if (!history.commits.some(commit => commit.id === endpoints.target) || (endpoints.base != null && !history.topology.some(commit => commit.id === endpoints.base))) endpoints = history.endpoints;
  const next = await captureChanges(root, endpoints, history);
  // A commit link's notice stays until the comparison or the branches change.
  const unchanged = next.endpoints.target === previous.endpoints.target && next.endpoints.base === previous.endpoints.base && history.tips.join() === previous.history.tips.join();
  if (unchanged) next.notice = previous.notice;
  return next;
}
