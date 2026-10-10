import { expect, test } from "bun:test";
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorkspaceEgressProxy } from "../src/egress/egress-proxy.ts";
import { ensureMitmCa } from "../src/egress/mitm-ca.ts";
import { createWorkspaceSecretContext, forgetWorkspaceSecretContext } from "../src/secrets/workspace-secrets.ts";

test("custom model hosts cannot authorize private destinations through workspace egress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "custom-model-egress-"));
  const socketPath = join(directory, "egress.sock");
  const workspaceId = "custom-model-destination-test";
  const destinations = new Map([
    ["public-model.example", "8.8.8.8"],
    ["tailnet-model.example", "100.100.1.2"],
    ["localhost", "127.0.0.1"],
    ["192.168.1.2", "192.168.1.2"],
    ["host.docker.internal", "172.17.0.1"],
  ]);
  const upstreamCalls: string[] = [];
  const proxy = await startWorkspaceEgressProxy({
    socketPath,
    ca: await ensureMitmCa({ kintsugiDataDir: directory, dockerHostKintsugiDataDir: directory, dockerBridgeHost: "127.0.0.1" }),
    getContext: () => createWorkspaceSecretContext(workspaceId),
    upstreamDnsLookup: async hostname => [{ address: destinations.get(hostname)!, family: 4 }],
    upstreamProxyForUrl: () => "",
    upstreamFetch: async url => { upstreamCalls.push(url); return new Response("stub public endpoint"); },
  });
  try {
    for (const hostname of destinations.keys()) {
      const status = await new Promise<number>((resolve, reject) => {
        request({ socketPath, method: "POST", path: `http://${hostname}/v1/chat/completions`, headers: { host: hostname } }, response => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        }).on("error", reject).end("{}");
      });
      expect(status).toBe(hostname === "public-model.example" ? 200 : 403);
    }
    expect(upstreamCalls).toEqual(["http://8.8.8.8/v1/chat/completions"]);
  } finally {
    await proxy.close();
    forgetWorkspaceSecretContext(workspaceId);
    await rm(directory, { recursive: true, force: true });
  }
});
