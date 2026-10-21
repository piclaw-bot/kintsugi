/** Shared by all native code-mode sandboxes in this host process. */
export function createCodemodeWorkerAdmission(limit: number): () => () => void {
  let workers = 0;
  return () => {
    if (workers >= limit) throw new Error(`Code mode has reached its ${limit}-worker limit. Wait for a running or cancelled worker to exit before retrying.`);
    workers++;
    // Pi 1.3 releases this reservation on actual worker exit, not on timeout or Stop.
    return () => { workers--; };
  };
}
