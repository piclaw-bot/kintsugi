import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceTemplate, listWorkspaceTemplates, setWorkspaceTemplateDockerfile, updateWorkspaceTemplate } from "../src/workspace-template.ts";

test("project Dockerfile persists, survives repository edits, validates and clears", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workspace-template-dockerfile-"));
  try {
    const file = join(dir, "projects.json");
    const { workspaceTemplate } = await addWorkspaceTemplate("/tmp/example", file);
    expect(workspaceTemplate.dockerfile).toBeUndefined();
    const dockerfile = "FROM kintsugi-workspace\nRUN echo custom\n";
    await setWorkspaceTemplateDockerfile(workspaceTemplate.id, dockerfile, file);
    await updateWorkspaceTemplate(workspaceTemplate.id, { name: "Renamed", spec: "/tmp/example" }, file);
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]!.dockerfile).toBe(dockerfile);
    await expect(setWorkspaceTemplateDockerfile(workspaceTemplate.id, "FROM ubuntu", file)).rejects.toThrow("FROM kintsugi-workspace");
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]!.dockerfile).toBe(dockerfile);
    await setWorkspaceTemplateDockerfile(workspaceTemplate.id, " \n", file);
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]!.dockerfile).toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
