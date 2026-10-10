import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryWorkspaceImageTag, workspaceDockerfile } from "./index.ts";

test("project Dockerfile overrides repository without modifying it and keys image reuse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dockerfile-selection-"));
  try {
    await mkdir(join(dir, ".kintsugi"));
    const repository = join(dir, ".kintsugi/Dockerfile");
    const shared = "FROM kintsugi-workspace\nRUN echo shared\n";
    const custom = "FROM kintsugi-workspace\nRUN echo custom\n";
    await writeFile(repository, shared);
    const selected = await workspaceDockerfile(dir, custom);
    expect(await readFile(selected, "utf8")).toBe(custom);
    expect(await readFile(repository, "utf8")).toBe(shared);
    expect(await workspaceDockerfile(dir)).toBe(repository);
    expect(await workspaceDockerfile(dir, "  ")).toBe(repository);
    expect(await workspaceDockerfile(dir, "")).toBe(repository);
    const baseline = "FROM kintsugi-workspace\n";
    const baselinePath = await workspaceDockerfile(dir, baseline);
    expect(baselinePath).not.toBe(repository);
    expect(await readFile(baselinePath, "utf8")).toBe(baseline);
    expect(await readFile(repository, "utf8")).toBe(shared);
    expect(repositoryWorkspaceImageTag("base", custom)).not.toBe(repositoryWorkspaceImageTag("base", shared));
    await rm(repository);
    expect(await readFile(await workspaceDockerfile(dir, custom), "utf8")).toBe(custom);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
