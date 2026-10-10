import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceTemplate, getWorkspaceTemplateConfiguration, listWorkspaceTemplates, setWorkspaceTemplatePreloadImages, updateWorkspaceTemplate } from "../src/workspace-template.ts";

test("preload settings preserve old projects, normalize references and do not invalidate existing workspaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workspace-template-preload-"));
  try {
    const file = join(dir, "projects.json");
    const { workspaceTemplate } = await addWorkspaceTemplate("/tmp/example", file);
    expect(workspaceTemplate.preloadImages).toEqual([]);
    const fingerprint = workspaceTemplate.configurationFingerprint;
    const images = ["kintsugi:default-workspace", "registry.example:5000/team/image:tag@sha256:" + "a".repeat(64)];
    const updated = await setWorkspaceTemplatePreloadImages(workspaceTemplate.id, [` ${images[0]} `, images[1]!, images[0]!], file);
    expect(updated.workspaceTemplate.preloadImages).toEqual(images);
    expect(updated.workspaceTemplate.configurationFingerprint).toBe(fingerprint);
    await updateWorkspaceTemplate(workspaceTemplate.id, { name: "Renamed", spec: "/tmp/example" }, file);
    expect((await getWorkspaceTemplateConfiguration(workspaceTemplate.id, file)).preloadImages).toEqual(images);
    for (const invalid of ["", "https://registry/image", "postgres:17 other", "--help", "image\nnext"]) {
      await expect(setWorkspaceTemplatePreloadImages(workspaceTemplate.id, [invalid], file)).rejects.toThrow("Invalid image reference");
    }
    expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]!.preloadImages).toEqual(images);
    await setWorkspaceTemplatePreloadImages(workspaceTemplate.id, [], file);
    expect((await getWorkspaceTemplateConfiguration(workspaceTemplate.id, file)).preloadImages).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
