import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { runCommand, shellQuote, withCommandSignal } from "@kintsugi/core";
import { codeSearchSchema, codeRewriteSchema } from "../../src/server/structural-code.ts";
const helper = new URL("../../workspace_tools/kintsugi-code", import.meta.url).pathname;
const workspaceTest = test.skipIf(process.platform !== "linux");
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const source = "console.log(1);\n";
const input = { pattern: "console.log($X)", rewrite: "logger.info($X)", lang: "typescript", path: "example.ts" };
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
function match(text = "console.log(1)", replacement = "logger.info(1)", start = 0) { return { file: "STDIN", text, replacement, replacementOffsets: { start, end: start + Buffer.byteLength(text) }, range: { start: { line: 0, column: 0 } } }; }
async function fixture(records = [match()]) {
  const root = await mkdtemp(join(tmpdir(), "structural-code-")); directories.push(root);
  const binary = join(root, "engine"), config = join(root, "sgconfig.yml"), file = join(root, "example.ts");
  await writeFile(file, source); await writeFile(config, "ruleDirs: []\n");
  const output = records.map(record => JSON.stringify(record)).join("\n");
  await writeFile(binary, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' ${shellQuote(output)}\n`, { mode: 0o755 });
  const args = ["bun", helper, "run", root, binary, config];
  async function run(request: typeof input & { dry_run?: boolean; expected_revision?: string; limit?: number }) {
    const result = await runCommand(args, { stdin: JSON.stringify(request), maxOutputBytes: 131072 });
    return { code: result.exitCode, body: JSON.parse(result.stdout.toString("utf8")) };
  }
  return { root, binary, file, config, args, run };
}

test("schemas bound structural inputs and exclude host/binary/config substitution", () => {
  expect(Value.Check(codeSearchSchema, { pattern: "$X", lang: "typescript" })).toBe(true);
  for (const extra of [{ limit: 0 }, { limit: 101 }, { lang: "--help" }, { pattern: "x".repeat(4097) }, { binary: "/tmp/evil" }, { root: "/" }, { dry_run: false }]) expect(Value.Check(codeSearchSchema, { pattern: "$X", lang: "typescript", ...extra })).toBe(false);
  expect(Value.Check(codeRewriteSchema, input)).toBe(true);
  expect(Value.Check(codeRewriteSchema, { ...input, expected_revision: "old" })).toBe(false);
});
workspaceTest("default dry-run captures revisions and never modifies source", async () => {
  const f = await fixture(), result = await f.run(input);
  expect(result.code).toBe(0); expect(result.body).toMatchObject({ dry_run: true, applied: false, revision: hash(source), truncated: false });
  expect(result.body.matches[0]).toMatchObject({ file: f.file, line: 1, column: 1, replacement: "logger.info(1)" });
  expect(await readFile(f.file, "utf8")).toBe(source);
});
workspaceTest("an explicit matching revision applies atomically and preserves executable permissions", async () => {
  const f = await fixture(); await chmod(f.file, 0o751);
  const original = await lstat(f.file), preview = await f.run(input);
  const result = await f.run({ ...input, dry_run: false, expected_revision: preview.body.revision });
  expect(result.body).toMatchObject({ ok: true, applied: true, revision: hash("logger.info(1);\n") });
  expect(await readFile(f.file, "utf8")).toBe("logger.info(1);\n");
  expect((await lstat(f.file)).mode & 0o777).toBe(0o751);
  expect((await lstat(f.file)).ino).not.toBe(original.ino);
  expect((await readdir(f.root)).some(name => name.includes(".kintsugi-code-"))).toBe(false);
});
workspaceTest("missing/stale revisions, directory applies and overlapping edits cannot write", async () => {
  const f = await fixture([match(), match()]);
  expect((await f.run({ ...input, dry_run: false })).body.error).toContain("expected_revision");
  expect((await f.run({ ...input, dry_run: false, expected_revision: "0".repeat(64) })).body.error).toContain("revision changed");
  expect((await f.run({ ...input, path: ".", dry_run: false, expected_revision: hash(source) })).body.error).toContain("one file");
  expect((await f.run({ ...input, dry_run: false, expected_revision: hash(source) })).body.error).toContain("Overlapping");
  expect(await readFile(f.file, "utf8")).toBe(source);
});
workspaceTest("concurrent source edits and chmod changes are rejected without overwriting them", async () => {
  const f = await fixture();
  for (const change of [`printf 'external edit\\n' > ${shellQuote(f.file)}`, `chmod 600 ${shellQuote(f.file)}`]) {
    await writeFile(f.file, source); await chmod(f.file, 0o644);
    await writeFile(f.binary, `#!/bin/sh\ncat >/dev/null\n${change}\nprintf '%s\\n' ${shellQuote(JSON.stringify(match()))}\n`);
    expect((await f.run({ ...input, dry_run: false, expected_revision: hash(source) })).body.error).toContain("Source changed during");
    if (change.startsWith("printf")) expect(await readFile(f.file, "utf8")).toBe("external edit\n");
    else expect((await lstat(f.file)).mode & 0o777).toBe(0o600);
  }
});
workspaceTest("workspace traversal, escaping symlinks, FIFOs and oversized files are rejected", async () => {
  const f = await fixture(), outside = await mkdtemp(join(tmpdir(), "structural-outside-")); directories.push(outside);
  await writeFile(join(outside, "secret.ts"), source); await symlink(outside, join(f.root, "outside"));
  expect((await f.run({ ...input, path: "../escape" })).body.error).toContain("inside the workspace root");
  expect((await f.run({ ...input, path: "outside/secret.ts" })).body.error).toContain("symlinks outside");
  await writeFile(f.file, "x".repeat(1024 * 1024 + 1));
  expect((await f.run(input)).body.error).toContain("at most 1 MiB");
  await runCommand(["mkfifo", join(f.root, "pipe")]);
  expect((await f.run({ ...input, path: "pipe" })).body.error).toContain("regular files and directories");
});
workspaceTest("truncated previews cannot apply and huge diagnostics are bounded", async () => {
  const f = await fixture([match(), match()]);
  expect((await f.run({ ...input, limit: 1 })).body.truncated).toBe(true);
  expect((await f.run({ ...input, limit: 1, dry_run: false, expected_revision: hash(source) })).body.error).toContain("truncated");
  await writeFile(f.binary, '#!/bin/sh\nexec python3 -c \'import sys; sys.stderr.write("x"*1000000)\'\n');
  const result = await f.run(input);
  expect(result.body.error).toContain("diagnostics exceeded 64 KiB");
  expect(JSON.stringify(result.body).length).toBeLessThan(5000);
  expect(await readFile(f.file, "utf8")).toBe(source);
});
workspaceTest("parser argv disables project plugins and never asks ast-grep to write files", async () => {
  const f = await fixture();
  await writeFile(f.binary, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "$@" > ${shellQuote(join(f.root, "args"))}\nprintf '%s\\n' ${shellQuote(JSON.stringify(match()))}\n`);
  await f.run(input);
  const args = await readFile(join(f.root, "args"), "utf8");
  expect(args).toContain(`--config\n${f.config}\n--custom-languages=ignore\n--threads=1\n`);
  expect(args).toContain("--stdin"); expect(args).not.toContain("--update-all");
});
workspaceTest("cancellation kills the parser with its owning process group before any write", async () => {
  const f = await fixture(), pidFile = join(f.root, "parser-pid");
  await writeFile(f.binary, `#!/bin/sh\necho $$ > ${shellQuote(pidFile)}\nexec sleep 30\n`);
  const controller = new AbortController();
  const work = withCommandSignal(controller.signal, () => runCommand(f.args, { stdin: JSON.stringify({ ...input, dry_run: false, expected_revision: hash(source) }) })).catch(error => error);
  for (let attempt = 0; attempt < 200 && !(await Bun.file(pidFile).exists()); attempt++) await Bun.sleep(10);
  const pid = Number(await readFile(pidFile, "utf8")); controller.abort(new Error("cancelled"));
  expect(await work).toMatchObject({ message: "cancelled" });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") break; throw error; }
    await Bun.sleep(10);
  }
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await readFile(f.file, "utf8")).toBe(source);
});
workspaceTest("parser wall-clock deadline stops work without writing", async () => {
  const f = await fixture(); await writeFile(f.binary, "#!/bin/sh\nexec sleep 30\n");
  const result = await f.run({ ...input, dry_run: false, expected_revision: hash(source) });
  expect(result.body.error).toContain("15 second deadline"); expect(await readFile(f.file, "utf8")).toBe(source);
}, 20000);

workspaceTest("model-output truncation is detected before an otherwise valid file apply", async () => {
  const text = `console.log("${"x".repeat(900)}")`, replacement = text.replace("console.log", "logger.info");
  const records = Array.from({ length: 30 }, (_, index) => match(text, replacement, index * (Buffer.byteLength(text) + 2)));
  const f = await fixture(records), contents = `${text};\n`.repeat(30); await writeFile(f.file, contents);
  const preview = await f.run(input); expect(preview.body.truncated).toBe(true);
  const result = await f.run({ ...input, dry_run: false, expected_revision: hash(contents) });
  expect(result.body.error).toContain("output budget"); expect(await readFile(f.file, "utf8")).toBe(contents);
});

workspaceTest("read-only source can be previewed but not replaced through directory write permission", async () => {
  if (process.getuid?.() === 0) return; // Root bypasses POSIX write bits; the workspace tool runs as agent.
  const f = await fixture(); await chmod(f.file, 0o444);
  expect((await f.run(input)).body.ok).toBe(true);
  expect((await f.run({ ...input, dry_run: false, expected_revision: hash(source) })).body.ok).toBe(false);
  expect(await readFile(f.file, "utf8")).toBe(source);
});
