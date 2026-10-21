import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeSubagentRows } from "../src/server/rows.ts";

const row = JSON.stringify({ type: "assistant", uuid: "reply", isSidechain: true, timestamp: "2026-10-21T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "Sidechain answer" }] } });

test("background transcript identities cannot introduce host path segments", async () => {
  await expect(readClaudeSubagentRows("/tmp", "session", "../../other")).rejects.toThrow("identity");
  await expect(readClaudeSubagentRows("/tmp", "../other", "agent")).rejects.toThrow("identity");
});

test("background transcripts reject file and parent-directory symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-background-"));
  try {
    const directory = join(root, "session", "subagents");
    await mkdir(directory, { recursive: true });
    await writeFile(join(root, "outside.jsonl"), row);
    await symlink(join(root, "outside.jsonl"), join(directory, "agent-linked.jsonl"));
    await expect(readClaudeSubagentRows(root, "session", "linked")).rejects.toThrow("non-symlinked");
    await symlink(directory, join(root, "linked-dir"));
    await writeFile(join(directory, "agent-direct.jsonl"), row);
    await expect(readClaudeSubagentRows(root, "linked-dir", "direct")).resolves.toEqual([]);
    await symlink(join(root, "session"), join(root, "linked-session"));
    await expect(readClaudeSubagentRows(root, "linked-session", "direct")).rejects.toThrow("non-symlinked");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("long background journals expose only their bounded tail, including workflow sidechains", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-background-"));
  try {
    const directory = join(root, "session", "subagents", "workflows", "run-1");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "agent-worker.jsonl"), "x".repeat(2 * 1024 * 1024) + "\n" + row + "\n");
    expect(await readClaudeSubagentRows(root, "session", "worker", true)).toMatchObject([{ kind: "assistant", content: [{ type: "text", text: "Sidechain answer" }] }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
