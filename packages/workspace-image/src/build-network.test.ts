import type { JsonObject } from "@kintsugi/core";
import { expect, test } from "bun:test";
import { protectedRepositoryBuildCommand } from "./build-network.ts";

const protectedResources = { buildClientNetworkPolicy: 1 };

test("repository builds reject missing and old System client protection", () => {
  const invalid: JsonObject[] = [{}, { workloadsCgroupParent: "/workloads" }, { buildClientNetworkPolicy: 0 }, { buildClientNetworkPolicy: "1" }];
  for (const resources of invalid) {
    expect(() => protectedRepositoryBuildCommand(resources, ["docker"])).toThrow("build-client network protection");
  }
  expect(() => protectedRepositoryBuildCommand(protectedResources, ["docker"])).not.toThrow();
});

test("CLI migrates before exec, fails on migration error, and preserves arguments", async () => {
  const args = ["docker", "--host", "unix:///control/docker.sock", "build", "path with spaces"];
  const command = protectedRepositoryBuildCommand(protectedResources, args);
  expect(command.slice(0, 2)).toEqual(["sh", "-ec"]);
  expect(command[2]).toBe('echo $$ > /run/kintsugi-system/build-client-processes/cgroup.procs; exec "$@"');
  expect(command.slice(4)).toEqual(args);
  const failing = protectedRepositoryBuildCommand(protectedResources, ["sh", "-c", "echo SHOULD_NOT_RUN"]);
  failing[2] = failing[2]!.replace("/run/kintsugi-system/build-client-processes/cgroup.procs", `/nonexistent-build-client-${crypto.randomUUID()}/cgroup.procs`);
  const child = Bun.spawn(failing, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(stdout).not.toContain("SHOULD_NOT_RUN");
});
