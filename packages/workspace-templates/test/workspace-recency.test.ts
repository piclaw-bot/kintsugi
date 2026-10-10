import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceTemplate, listWorkspaceTemplates, updateWorkspaceTemplate } from "@kintsugi/workspace-templates";
import { recordWorkspaceCreation } from "../src/workspace-template.ts";

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "kintsugi-workspace-template-recency-"));
  file = join(directory, "projects.json");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test("adding a template counts as using it, then workspace creation advances recency", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/org/recent.git", file);
  expect(workspaceTemplate.createdAt).toBeNumber();
  expect(workspaceTemplate.lastUsedAt).toBe(workspaceTemplate.createdAt);
  const later = workspaceTemplate.createdAt! + 1000;
  await recordWorkspaceCreation(workspaceTemplate.id, later, file);
  expect((await listWorkspaceTemplates(file)).workspaceTemplates[0]?.lastUsedAt).toBe(later);
});

test("workspace creation persists recency without changing workspace configuration", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/org/repo.git", file);
  expect(workspaceTemplate.lastWorkspaceCreatedAt).toBeUndefined();
  await recordWorkspaceCreation(workspaceTemplate.id, 1000, file);
  const stored = (await listWorkspaceTemplates(file)).workspaceTemplates[0];
  expect(stored.lastWorkspaceCreatedAt).toBe(1000);
  expect(stored.configurationFingerprint).toBe(workspaceTemplate.configurationFingerprint);
  await updateWorkspaceTemplate(workspaceTemplate.id, { name: "Renamed", spec: workspaceTemplate.gitUrl }, file);
  expect((await listWorkspaceTemplates(file)).workspaceTemplates[0].lastWorkspaceCreatedAt).toBe(1000);
});

test("concurrent creations retain the latest timestamp and leave other templates untouched", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/org/used.git", file);
  const { workspaceTemplate: unused } = await addWorkspaceTemplate("https://github.com/org/unused.git", file);
  await Promise.all([2000, 3000, 1000].map((at) => recordWorkspaceCreation(workspaceTemplate.id, at, file)));
  const { workspaceTemplates } = await listWorkspaceTemplates(file);
  expect(workspaceTemplates.find((entry) => entry.id === workspaceTemplate.id)?.lastWorkspaceCreatedAt).toBe(3000);
  expect(workspaceTemplates.find((entry) => entry.id === unused.id)?.lastWorkspaceCreatedAt).toBeUndefined();
});
