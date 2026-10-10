import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, spyOn, test } from "bun:test";
import { workspaceWorkHostPath } from "@kintsugi/workspace";
import { createKintsugiEventBus } from "@kintsugi/core";
import { publishWorkspaceAgentBusy } from "../../agent/src/server/workspace-agent-busy.ts";
import type { CliAgentAdapter } from "../src/server/adapter.ts";
import type { CliAgents } from "../src/server/agents.ts";
import { cliCompletionCatalogId, cliTranscriptChannel } from "../src/server/transcript-routes.ts";

function fixture(loadTranscript: NonNullable<CliAgentAdapter["loadTranscript"]>, workspaceId = "workspace") {
  const agentId = crypto.randomUUID();
  const adapter: CliAgentAdapter = {
    id: "review", label: "Review", iconHtml: "",
    requireSetup: async () => {},
    settings: { renderFooter: async () => "", prepare: async () => ({}) },
    prepareSession: async () => ({}),
    launchScript: () => "true",
    loadTranscript,
  };
  const agents: Pick<CliAgents, "ready"> = {
    ready: async () => ({ id: agentId, title: "Review", tmuxSession: `review-${agentId}`, input: { text: "", images: [], attachmentNotes: [] } }),
  };
  return {
    agentId,
    channel: cliTranscriptChannel(adapter, agents),
    identifier: { channel: "module" as const, name: "review-transcript", workspaceId, params: { agentId } },
    finishTurn() {
      publishWorkspaceAgentBusy({ workspaceId, agentKey: `agent:${agentId}`, busy: false });
    },
  };
}

test("a failed incremental history read is reported and queued publications continue", async () => {
  const failedRead = Promise.withResolvers<undefined>();
  const recovered = Promise.withResolvers<void>();
  const failure = new Error("history read failed");
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    if (reads === 2) return failedRead.promise;
    return undefined;
  });
  const report = spyOn(console, "error").mockImplementation(() => {});
  let publications = 0;
  const subscription = await f.channel.subscribe(f.identifier, () => {
    publications++;
    if (publications === 2) recovered.resolve();
  }, createKintsugiEventBus());
  try {
    f.finishTurn();
    f.finishTurn();
    failedRead.reject(failure);
    await recovered.promise;
    expect(reads).toBe(3);
    expect(publications).toBe(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(`Could not publish Review transcript for ${f.agentId}`, failure);
  } finally {
    subscription.unsubscribe();
    report.mockRestore();
  }
});

test("an initial history read failure still rejects channel subscription", async () => {
  const failure = new Error("initial history read failed");
  let reads = 0;
  const f = fixture(async () => { reads++; throw failure; });
  await expect(f.channel.subscribe(f.identifier, () => {}, createKintsugiEventBus())).rejects.toBe(failure);
  f.finishTurn();
  await Promise.resolve();
  expect(reads).toBe(1);
});

test("a finished turn refreshes the composer catalog with prompt templates it added", async () => {
  const workspaceId = `catalog-${crypto.randomUUID()}`;
  const f = fixture(async () => undefined, workspaceId);
  const published: string[] = [];
  const refreshed = Promise.withResolvers<void>();
  const subscription = await f.channel.subscribe(f.identifier, (html) => {
    published.push(html);
    if (published.length === 2) refreshed.resolve();
  }, createKintsugiEventBus());
  try {
    expect(published[0]).not.toContain("/ship");
    const prompts = join(workspaceWorkHostPath(workspaceId), ".kintsugi/prompts");
    await mkdir(prompts, { recursive: true });
    await writeFile(join(prompts, "ship.md"), "---\ncomposer-button: true\nshortcut: s\n---\nShip it");
    f.finishTurn();
    await refreshed.promise;
    expect(published[1]).toContain(`target="${cliCompletionCatalogId(workspaceId, f.agentId)}"`);
    expect(published[1]).toContain('data-command-trigger="/ship"');
  } finally {
    subscription.unsubscribe();
  }
});
