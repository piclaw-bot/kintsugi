import type { JsonObject } from "@kintsugi/core";
import { readJsonSettings } from "@kintsugi/core/json-settings";

/** The CLI session auth provider and credential-helper children fetch URLs chosen
 * by registries. A private daemon alone does not isolate those host-side fetches.
 * No local-Docker or older-System fallback for repository-controlled builds. */
export async function repositoryBuildCommand(args: string[]): Promise<string[]> {
  const resources = await readJsonSettings("/run/kintsugi-system/resources.json");
  return protectedRepositoryBuildCommand(resources, args);
}

export function protectedRepositoryBuildCommand(resources: JsonObject, args: string[]): string[] {
  if (resources.buildClientNetworkPolicy !== 1)
    throw new Error("Repository Dockerfile builds require System build-client network protection. Update System or use a prebuilt workspace image.");

  // sh -e makes a failed migration fatal; exec and all helpers inherit membership.
  return ["sh", "-ec", 'echo $$ > /run/kintsugi-system/build-client-processes/cgroup.procs; exec "$@"', "kintsugi-build", ...args];
}
