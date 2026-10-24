import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("the standalone System entrypoint loads every module before parsing arguments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "system-entrypoint-"));
  try {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL("../src/supervisor.ts", import.meta.url))],
      outdir: directory, target: "bun", naming: "supervisor.js",
    });
    if (!result.success) throw new AggregateError(result.logs);
    // An unknown option stops before /data writes, listeners or privileged setup.
    // Import evaluation still runs first, with no checkout cwd or module path.
    const child = Bun.spawn([process.execPath, join(directory, "supervisor.js"), "--source-free-import-probe"], {
      cwd: directory, env: { PATH: process.env.PATH },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("ERR_PARSE_ARGS_UNKNOWN_OPTION");
    expect(stderr).toContain("--source-free-import-probe");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
