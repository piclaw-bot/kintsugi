import { afterEach, describe, expect, test } from "bun:test";
import { $ } from "bun";
import { attachHostObservableTerminal, buildKillSessionCommand, buildObservableSessionCommand } from "../../src/server/index.ts";
import { observableTerminalCols, observableTerminalRows } from "../../src/server/constants.ts";

const sessions: string[] = [];

async function sh(command: string): Promise<string> {
  const result = await $`sh -lc ${command}`.quiet();
  return result.stdout.toString();
}

describe.skip("observable terminal integration", () => {
  afterEach(async () => {
    for (const session of sessions.splice(0)) await sh(buildKillSessionCommand(session)).catch(() => undefined);
  });

  test("host readonly attach works when parent TERM is dumb", async () => {
    const originalTerm = process.env.TERM;
    const session = `kintsugi-observable-test-${Date.now()}`;
    sessions.push(session);
    process.env.TERM = "dumb";
    try {
      await sh(buildObservableSessionCommand({ session, cwd: process.cwd(), command: "printf 'docker build progress\\n'; sleep 1", remainOnExit: true }));
      await new Promise<void>((resolve, reject) => {
        const decoder = new TextDecoder();
        let output = "";
        const timer = setTimeout(() => reject(new Error(output || "timed out waiting for attach output")), 3_000);
        attachHostObservableTerminal({ session, cols: observableTerminalCols, rows: observableTerminalRows, readonly: true }, {
          onData: (chunk) => {
            output += decoder.decode(chunk, { stream: true });
            if (output.includes("docker build progress")) {
              clearTimeout(timer);
              resolve();
            }
          },
          onExit: (exitCode) => {
            if (!output.includes("docker build progress")) {
              clearTimeout(timer);
              reject(new Error(`${output || "attach exited before output"} (exit ${exitCode})`));
            }
          },
        });
      });
    } finally {
      if (originalTerm === undefined) delete process.env.TERM;
      else process.env.TERM = originalTerm;
    }
  });
});
