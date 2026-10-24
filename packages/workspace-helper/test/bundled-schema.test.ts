import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("a relocated helper bundle imports without its source checkout or proto file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helper-bundle-"));
  try {
    const build = join(directory, "build");
    const runtime = join(directory, "runtime");
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      outdir: build, target: "bun", naming: "helper.js",
    });
    if (!result.success) throw new AggregateError(result.logs);
    await mkdir(runtime);
    const bundle = join(runtime, "helper.js");
    await rename(join(build, "helper.js"), bundle);
    await rm(build, { recursive: true });
    expect(await Bun.file(join(directory, "proto/workspace_helper.proto")).exists()).toBe(false);
    const child = Bun.spawn([process.execPath, "-e", `
      const helper = await import(${JSON.stringify(bundle)});
      if (typeof helper.runWorkspaceProcess !== "function" || typeof helper.statWorkspaceFiles !== "function") throw new Error("Missing helper exports");
      console.log("embedded schema loaded");
    `], { cwd: runtime, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout.trim()).toBe("embedded schema loaded");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 30_000);
