import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceTemplate, globalWorkspaceConfiguration, getConfiguration } from "../src/index.ts";
import { effectivePrivateNetworkAccess, getPrivateNetworkAccess, setPrivateNetworkAccess } from "../src/private-network.ts";

async function fixture(action: (file: string, templatesFile: string, id: string, second: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "private-network-settings-"));
  const file = join(dir, "destinations.json"), templates = join(dir, "projects.json");
  const id = (await addWorkspaceTemplate("https://example.com/one.git", templates)).workspaceTemplate.id;
  const second = (await addWorkspaceTemplate("https://example.com/two.git", templates)).workspaceTemplate.id;
  try { await action(file, templates, id, second); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("global and per-template lists combine canonically without changing legacy template files", () => fixture(async (file, templates, id, second) => {
  const before = await readFile(templates, "utf8");
  expect(await getPrivateNetworkAccess(globalWorkspaceConfiguration, file, templates)).toEqual([]);
  await setPrivateNetworkAccess(globalWorkspaceConfiguration, "DB.INTERNAL.:05432\n192.168.1.20:22", file, templates);
  await setPrivateNetworkAccess(id, "db.internal:5432\n[fd12::1]:443", file, templates);
  expect(await effectivePrivateNetworkAccess(id, file, templates)).toEqual([{ host: "db.internal", port: 5432 }, { host: "192.168.1.20", port: 22 }, { host: "fd12::1", port: 443 }]);
  expect(await effectivePrivateNetworkAccess(second, file, templates)).toHaveLength(2);
  expect(await readFile(templates, "utf8")).toBe(before);
  expect(await getConfiguration(globalWorkspaceConfiguration, templates)).not.toHaveProperty("privateNetworkAccess");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await setPrivateNetworkAccess(id, "", file, templates);
  expect(await getPrivateNetworkAccess(id, file, templates)).toEqual([]);
  expect(await effectivePrivateNetworkAccess(id, file, templates)).toHaveLength(2);
}));

test("concurrent scope edits do not lose one another, and rejected inputs leave settings unchanged", () => fixture(async (file, templates, id, second) => {
  await Promise.all([setPrivateNetworkAccess(id, "db.internal:5432", file, templates), setPrivateNetworkAccess(second, "192.168.2.20:22", file, templates)]);
  expect(await getPrivateNetworkAccess(id, file, templates)).toEqual(["db.internal:5432"]);
  expect(await getPrivateNetworkAccess(second, file, templates)).toEqual(["192.168.2.20:22"]);
  const before = await readFile(file, "utf8");
  await expect(setPrivateNetworkAccess(id, "127.0.0.1:3000", file, templates)).rejects.toThrow();
  await expect(setPrivateNetworkAccess("missing", "db.internal:22", file, templates)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before);
}));

test("corrupt stored lists fail closed instead of being silently reset", () => fixture(async (file, templates) => {
  await writeFile(file, JSON.stringify({ global: ["169.254.169.254:80"], templates: {} }));
  await expect(getPrivateNetworkAccess(globalWorkspaceConfiguration, file, templates)).rejects.toThrow();
  await expect(setPrivateNetworkAccess(globalWorkspaceConfiguration, "db.internal:22", file, templates)).rejects.toThrow();
  expect(JSON.parse(await readFile(file, "utf8")).global).toEqual(["169.254.169.254:80"]);
}));
