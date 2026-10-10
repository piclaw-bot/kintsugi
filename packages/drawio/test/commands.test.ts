import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createKintsugiEventBus, getKintsugiRuntimeContext } from "@kintsugi/core";
import { kintsugiServerModule as module } from "../src/server/index.ts";
import { views } from "../src/server/state.ts";

const workspaceIds: string[] = [];
function workspaceId(): string {
  const id = `drawio-test-${crypto.randomUUID()}`;
  workspaceIds.push(id);
  return id;
}
afterEach(() => { for (const id of workspaceIds.splice(0)) views.delete(id); });

const command = module.commands![0]!;
const events = createKintsugiEventBus();

test("drawio.create persists independent diagram resources for each workspace", async () => {
  const first = workspaceId();
  const second = workspaceId();
  const result = await command.execute({ workspaceId: first, input: {}, events });
  const reference = result.createdWorkView!;
  expect(reference.type).toBe("drawio");
  expect(views.read(first)).toHaveLength(1);
  expect(reference.id).toBe(views.read(first)[0]!.id);
  expect(views.read(first)[0]!.path).toBe("");
  expect(views.read(second)).toEqual([]);
  const persisted = await readFile(join(getKintsugiRuntimeContext().kintsugiDataDir, "workspaces", first, "metadata", "drawio-work-views.json"), "utf8");
  expect(JSON.parse(persisted)).toEqual(views.read(first));
  await module.workViews![0]!.close!({ workspaceId: first, reference });
  expect(views.read(first)).toEqual([]);
});

test("invalid diagram paths fail before creating any resource", async () => {
  const id = workspaceId();
  for (const path of ["/etc/example.xml", "../example.drawio", "example.png"]) {
    await expect(command.execute({ workspaceId: id, input: { path, create: true }, events })).rejects.toThrow();
    expect(views.read(id)).toEqual([]);
  }
});

test("the public command rejects invalid input types", async () => {
  const id = workspaceId();
  await expect(command.execute({ workspaceId: id, input: { path: 5 }, events })).rejects.toThrow();
  await expect(command.execute({ workspaceId: id, input: { create: "yes" }, events })).rejects.toThrow();
  expect(views.read(id)).toEqual([]);
});
