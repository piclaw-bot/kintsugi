import { kintsugiDataPath, getKintsugiRuntimeContext } from "@kintsugi/core";
import { cancelWorkspaceSshTrust, decideWorkspaceSshTrust, onWorkspaceSshTrustChanged, requestWorkspaceSshTrust, workspaceSshTrustRequests } from "@kintsugi/workspace-templates";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestApp, temporaryKintsugiDataDir } from "./support/test-web-app.ts";

const dataDir = temporaryKintsugiDataDir();
beforeEach(dataDir.setUp);
afterEach(dataDir.tearDown);

async function requestTrust(workspaceId: string, host: string): Promise<{ result: Promise<string>; id: string }> {
  const changed = Promise.withResolvers<void>();
  const unsubscribe = onWorkspaceSshTrustChanged(id => { if (id === workspaceId) changed.resolve(); });
  const result = requestWorkspaceSshTrust(workspaceId, host, 22, `${host} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl`);
  try {
    await changed.promise;
    return { result, id: workspaceSshTrustRequests(workspaceId).at(-1)!.id };
  } finally {
    unsubscribe();
  }
}

for (const initiallyVisible of [false, true]) {
  test(`SSH approval uses ordinary workspace attention when initially ${initiallyVisible ? "visible" : "hidden"}`, async () => {
    const { registry } = createTestApp();
    const id = crypto.randomUUID();
    await registry.seed([{ id, title: "SSH attention" }]);
    const directory = kintsugiDataPath(getKintsugiRuntimeContext(), "ssh-agents", id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "known_hosts"), "");
    if (initiallyVisible) registry.setVisibility("browser", { workspaceId: id, surfaceKeys: [] });
    try {
      const first = await requestTrust(id, "first.example.test");
      expect(registry.get(id)?.requestingAttention).toBe(!initiallyVisible);
      expect(registry.get(id)?.phase.kind).toBe("runningPhase");
      registry.setVisibility("browser", { workspaceId: id, surfaceKeys: [] });
      expect(registry.get(id)?.requestingAttention).toBe(false);
      expect(workspaceSshTrustRequests(id)).toHaveLength(1);

      const second = await requestTrust(id, "second.example.test");
      expect(registry.get(id)?.requestingAttention).toBe(false);
      registry.disconnect("browser");
      await decideWorkspaceSshTrust(id, first.id, []);
      expect(await first.result).toBe("");
      expect(registry.get(id)?.requestingAttention).toBe(false);
      expect(workspaceSshTrustRequests(id)).toHaveLength(1);

      const third = await requestTrust(id, "third.example.test");
      expect(registry.get(id)?.requestingAttention).toBe(true);
      registry.setVisibility("browser", { workspaceId: id, surfaceKeys: [] });
      registry.disconnect("browser");
      const thirdRequest = workspaceSshTrustRequests(id).find(request => request.id === third.id)!;
      await decideWorkspaceSshTrust(id, third.id, thirdRequest.records.map(record => record.line));
      expect(await third.result).toContain("third.example.test");
      expect(registry.get(id)?.requestingAttention).toBe(false);
      cancelWorkspaceSshTrust(id);
      expect(await second.result).toBe("");
      expect(registry.get(id)?.requestingAttention).toBe(false);
    } finally {
      cancelWorkspaceSshTrust(id);
    }
  });
}
