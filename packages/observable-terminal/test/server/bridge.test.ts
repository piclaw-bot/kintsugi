import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { shellQuote } from "@kintsugi/core";

/** Exercise the actual workspace bridge through the attachment interface.
 * Only Docker and tmux are fixtures; the Bun process, PTY and pipes are real. */
async function scenario(script: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "terminal-bridge-"));
  try {
    const marker = join(directory, "session");
    const end = join(directory, "end");
    const failure = join(directory, "failure");
    await Bun.write(join(directory, "docker"), `#!/bin/sh\nwhile [ "$1" != "fixture" ]; do shift; done\nshift\nexec "$@"\n`);
    await Bun.write(join(directory, "tmux"), `#!/bin/sh
case "$*" in
  *has-session*)
    test ! -f ${shellQuote(failure)} || { echo 'tmux check failed' >&2; exit 1; }
    test -f ${shellQuote(marker)} || { echo "can't find session: fixture" >&2; exit 1; }
    exit 0
    ;;
  *)
    printf 'FINAL-OUTPUT\\n'
    test ! -f ${shellQuote(end)} || rm ${shellQuote(marker)}
    exit 0
    ;;
esac
`);
    await Promise.all(["docker", "tmux"].map(name => chmod(join(directory, name), 0o755)));
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect } from "bun:test";
      import { attachObservableTerminal } from ${JSON.stringify(join(import.meta.dir, "../../src/server/attach.ts"))};
      const marker = ${JSON.stringify(marker)}, end = ${JSON.stringify(end)}, failure = ${JSON.stringify(failure)};
      const options = { containerName: "fixture", session: "session with spaces", cols: 80, rows: 24, requireExistingServer: true, reportSessionMissing: true };
      async function attach(overrides = {}) {
        const exited = Promise.withResolvers();
        let output = "";
        const decoder = new TextDecoder();
        const connection = attachObservableTerminal({ ...options, ...overrides }, {
          onData: data => { output += decoder.decode(data, { stream: true }); },
          onExit: (code, reason) => exited.resolve({ code, reason, output }),
        });
        const result = await exited.promise;
        connection.close();
        return result;
      }
      ${script}
    `], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the bridge reports a session missing before attach without printing tmux errors", () => scenario(`
  expect(await attach()).toEqual({ code: 44, reason: "session-missing", output: "" });
`));

test("the bridge delivers final output before reporting a session removed while attached", () => scenario(`
  await Bun.write(marker, "exists");
  await Bun.write(end, "end after attach");
  const result = await attach();
  expect(result.code).toBe(44);
  expect(result.reason).toBe("session-missing");
  expect(result.output).toContain("FINAL-OUTPUT");
`));

test("detaching from an existing session remains reconnectable", () => scenario(`
  await Bun.write(marker, "exists");
  const result = await attach();
  expect(result.code).toBe(0);
  expect(result.reason).toBeUndefined();
  expect(result.output).toContain("FINAL-OUTPUT");
`));

test("unexpected session-check failures remain errors, not ended sessions", () => scenario(`
  await Bun.write(failure, "fail check");
  const result = await attach();
  expect(result.code).not.toBe(0);
  expect(result.reason).toBeUndefined();
  expect(result.output).toContain("tmux check failed");
`));

test("callers that do not request session detection retain their existing exit behavior", () => scenario(`
  const result = await attach({ reportSessionMissing: false });
  expect(result.code).toBe(0);
  expect(result.reason).toBeUndefined();
  expect(result.output).toContain("FINAL-OUTPUT");
`));
