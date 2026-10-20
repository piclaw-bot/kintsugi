// Run explicitly with: bun packages/core/test/docker-cancellation.integration.ts
import assert from "node:assert/strict";
import { runDocker, requireDocker } from "../src/docker.ts";
import { withCommandSignal, CommandOutputLimitError } from "../src/command-scope.ts";

const container = `kintsugi-command-check-${crypto.randomUUID().slice(0, 8)}`;
await requireDocker(["run", "--init", "-d", "--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--pids-limit", "128", "--network", "none", "--name", container, "ubuntu:24.04", "sleep", "infinity"]);
try {
  const signal = AbortSignal.timeout(10_000);
  const result = await withCommandSignal(signal, () => runDocker(["exec", "-i", container, "sh", "-c", "sleep 0.1; cat; exit 7"], { stdin: "payload" }));
  assert.equal(result.exitCode, 7, "wrapper must await command completion and preserve exit code");
  assert.equal(result.stdout, "payload", "wrapper must preserve stdin and stdout");

  const controller = new AbortController();
  const pending = withCommandSignal(controller.signal, () => runDocker(["exec", container, "sh", "-c", "touch /tmp/started; (sleep 1; touch /tmp/late) & wait"])).catch((error: Error) => error);
  await withCommandSignal(signal, async () => {
    while ((await runDocker(["exec", container, "test", "-f", "/tmp/started"])).exitCode !== 0) await Bun.sleep(10);
  });
  controller.abort(new Error("cancelled"));
  const cancelled = await pending;
  assert(cancelled instanceof Error);
  assert.equal(cancelled.message, "cancelled");
  await Bun.sleep(1200);
  assert.notEqual((await runDocker(["exec", container, "test", "-f", "/tmp/late"])).exitCode, 0, "cancelled remote children must not write after cancellation");
  const processes = await requireDocker(["exec", container, "ps", "-eo", "args"]);
  assert(!processes.stdout.includes("sleep 1"), "remote child must be terminated");
  for (const pipe of ["stdout", "stderr"]) {
    const marker = `/tmp/overflow-late-${pipe}`;
    const overflow = await withCommandSignal(AbortSignal.timeout(10000), () => runDocker(["exec", container, "sh", "-c", `(sleep 1; touch ${marker}) & yes x ${pipe === "stderr" ? ">&2" : ""}`], { maxOutputBytes: 4096 })).catch(error => error);
    assert(overflow instanceof CommandOutputLimitError, `${pipe} overflow must be explicit`);
    await Bun.sleep(1200);
    assert.notEqual((await runDocker(["exec", container, "test", "-f", marker])).exitCode, 0, "output overflow must stop remote children before reporting failure");
  }
  console.log("Docker command completion, streams, bounded pipes and remote process-group cancellation passed.");
} finally {
  await requireDocker(["rm", "-f", container]);
}
