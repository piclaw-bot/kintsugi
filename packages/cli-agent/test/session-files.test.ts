import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("private session writes preserve UTF-8 and empty files, keep contents off commands, and stop on failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cli-session-files-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { expect, mock } from "bun:test";
      import { readFile, stat, writeFile } from "node:fs/promises";
      const workspace = await import("@kintsugi/workspace");
      const commands = [];
      mock.module("@kintsugi/workspace", () => ({ ...workspace, execWorkspaceShell: async (_workspaceId, command, options) => {
        commands.push(command);
        const shell = Bun.spawn(["bash", "-c", command], { stdin: Buffer.from(options.stdin), stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([shell.exited, new Response(shell.stdout).text(), new Response(shell.stderr).text()]);
        return { exitCode, stdout, stderr, durationMs: 0 };
      } }));
      const { writeCliSessionFiles } = await import(${JSON.stringify(join(import.meta.dir, "../src/server/agents.ts"))});
      const session = { id: "session", directory: ${JSON.stringify(join(directory, "session 'quoted'"))}, turnSignalCommand: "unused" };
      const files = { "nested/unicode.txt": "private-token-λ🦋".repeat(1000), "empty.txt": "", "instructions.txt": "Full guidance\\n" + "x".repeat(12000) };
      await writeCliSessionFiles("workspace", session, files);
      expect(commands).toHaveLength(1);
      for (const [name, content] of Object.entries(files)) {
        const path = session.directory + "/" + name;
        expect(await readFile(path, "utf8")).toBe(content);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        if (content) expect(commands[0]).not.toContain(content);
      }
      await writeCliSessionFiles("workspace", session, { "instructions.txt": "Refreshed guidance" });
      expect(await readFile(session.directory + "/instructions.txt", "utf8")).toBe("Refreshed guidance");
      await writeFile(session.directory + "/blocked", "not a directory");
      await expect(writeCliSessionFiles("workspace", session, { "blocked/note.txt": "fail", "never-created.txt": "must not write" })).rejects.toThrow();
      expect(await Bun.file(session.directory + "/never-created.txt").exists()).toBe(false);
    `], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
