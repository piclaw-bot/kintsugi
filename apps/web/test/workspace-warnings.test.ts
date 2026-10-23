import { afterEach, beforeEach, expect, test } from "bun:test";
import { addWorkspaceTemplate, createWorkspaceTemplateEnvironmentVariable, createWorkspaceTemplateSecret, deleteWorkspaceTemplateEnvironmentVariable, deleteWorkspaceTemplateSecret, getWorkspaceTemplateConfiguration, isGitWorkspaceTemplateInit, listWorkspaceTemplates, updateWorkspaceTemplate, workspaceInitFromTemplate, setWorkspaceTemplateDockerfile, updateWorkspaceTemplateSecret } from "@kintsugi/workspace-templates";
import { workspaceWarnings } from "../src/server/workspace-warnings.ts";
import type { WorkspaceEntry } from "../src/server/workspace-registry.ts";
import { temporaryKintsugiDataDir } from "./support/test-web-app.ts";

const dataDir = temporaryKintsugiDataDir();
beforeEach(dataDir.setUp);
afterEach(dataDir.tearDown);

function entry(init?: WorkspaceEntry["init"]): WorkspaceEntry {
  return { id: "example", title: null, phase: { kind: "runningPhase", busy: false }, requestingAttention: false, parked: false, imageOutdated: false, lastActivityAt: 0, init };
}

async function warningsFor(workspace: WorkspaceEntry) {
  return workspaceWarnings(workspace, isGitWorkspaceTemplateInit(workspace.init) ? await getWorkspaceTemplateConfiguration(workspace.init.projectId) : undefined);
}

test("setup changes are compared to creation, survive reconstruction, and reverting removes the condition", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/org/example.git");
  const workspace = entry(workspaceInitFromTemplate(workspaceTemplate));
  expect(await warningsFor(workspace)).toEqual([]);
  const variable = await createWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, { name: "REGION", value: "eu" });
  const changed = await warningsFor(workspace);
  expect(changed.map((warning) => warning.kind)).toEqual(["project-settings-changed"]);
  expect(await warningsFor(entry(JSON.parse(JSON.stringify(workspace.init))))).toEqual(changed);
  expect(await warningsFor(entry(workspaceInitFromTemplate((await listWorkspaceTemplates()).workspaceTemplates[0]!)))).toEqual([]);
  await deleteWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, variable.id);
  expect(await warningsFor(workspace)).toEqual([]);
  await setWorkspaceTemplateDockerfile(workspaceTemplate.id, "FROM kintsugi-workspace\nRUN echo ready");
  expect((await warningsFor(workspace))[0]!.state).not.toBe(changed[0]!.state);
});

test("renaming a project is not a setup change", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/org/example.git");
  const workspace = entry(workspaceInitFromTemplate(workspaceTemplate));
  await updateWorkspaceTemplate(workspaceTemplate.id, { name: "Renamed", spec: "https://github.com/org/example.git" });
  expect(await warningsFor(workspace)).toEqual([]);
});

test("secrets without values produce no warnings, while annotations are live metadata", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/org/example.git");
  const values = { envName: "TOKEN", hostPattern: "api.example.com" };
  const secret = await createWorkspaceTemplateSecret(workspaceTemplate.id, values);
  const workspace = entry(workspaceInitFromTemplate((await listWorkspaceTemplates()).workspaceTemplates[0]!));
  expect((await warningsFor(workspace)).map((warning) => warning.kind)).toEqual([]);
  await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...values, annotation: "Tests" });
  expect(await warningsFor(workspace)).toEqual([]);
  await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...values, secretValue: "never expose this" });
  const warnings = await warningsFor(workspace);
  expect(warnings.map((warning) => warning.kind)).toEqual(["project-settings-changed"]);
  expect(JSON.stringify(warnings)).not.toContain("never expose this");
});

test("legacy snapshots do not invent configuration drift; gateway and image warnings remain independent", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/org/example.git");
  const workspace = entry({ type: "project.git", projectId: workspaceTemplate.id, name: workspaceTemplate.name, gitUrl: workspaceTemplate.gitUrl, branch: null, sessionShareKey: workspaceTemplate.sessionShareKey });
  await createWorkspaceTemplateEnvironmentVariable(workspaceTemplate.id, { name: "REGION", value: "eu" });
  expect(await warningsFor(workspace)).toEqual([]);
  workspace.imageOutdated = true;
  workspace.warnings = [{ kind: "preparation", message: "Gateway unavailable" }, { kind: "image", message: "Image inspection failed" }];
  expect((await warningsFor(workspace)).map((warning) => warning.kind)).toEqual(["preparation", "image"]);
});


test("only configured secrets contribute to setup drift", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/org/declarations.git");
  const workspace = entry(workspaceInitFromTemplate(workspaceTemplate));
  const values = { envName: "TOKEN", hostPattern: "api.example.com" };
  const secret = await createWorkspaceTemplateSecret(workspaceTemplate.id, { ...values });
  expect(await warningsFor(workspace)).toEqual([]);
  expect((await getWorkspaceTemplateConfiguration(workspaceTemplate.id)).configurationFingerprint).toBe(workspaceTemplate.configurationFingerprint);
  await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...values, placeholder: "TOKEN_PLACEHOLDER", annotation: "Tests" });
  expect((await warningsFor(workspace)).map(({ kind }) => kind)).toEqual([]);
  await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...values, secretValue: "configured-value" });
  expect((await warningsFor(workspace)).map(({ kind }) => kind)).toEqual(["project-settings-changed"]);
  const snapshot = await getWorkspaceTemplateConfiguration(workspaceTemplate.id);
  expect(snapshot.secrets[0]!.configured).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain("configured-value");
  expect(JSON.stringify(snapshot)).not.toContain("encryptedSecret");
  await deleteWorkspaceTemplateSecret(workspaceTemplate.id, secret.id);
  expect(await warningsFor(workspace)).toEqual([]);
});

test("one project snapshot supplies consistent warnings to every workspace in a refresh", async () => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/org/snapshot.git");
  const first = entry(workspaceInitFromTemplate(workspaceTemplate));
  const second = { ...first, id: "second" };
  const values = { envName: "TOKEN", hostPattern: "api.example.com" };
  const secret = await createWorkspaceTemplateSecret(workspaceTemplate.id, values);
  const snapshot = await getWorkspaceTemplateConfiguration(workspaceTemplate.id);
  const before = workspaceWarnings(first, snapshot);
  await updateWorkspaceTemplateSecret(workspaceTemplate.id, secret.id, { ...values, secretValue: "real-value" });
  expect(workspaceWarnings(second, snapshot)).toEqual(before);
  expect(before.map(({ kind }) => kind)).toEqual([]);
  expect((await warningsFor(second)).map(({ kind }) => kind)).toEqual(["project-settings-changed"]);
});
