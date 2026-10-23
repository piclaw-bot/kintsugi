#!/usr/bin/env bun
/** Builds the helper into workspace_tools, for the platform the Docker daemon runs workspaces on. */
import { buildGoProgram, requireDocker } from "@kintsugi/core";
import { fileURLToPath } from "node:url";

const platform = (await requireDocker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"])).stdout.trim();
await buildGoProgram(fileURLToPath(new URL("../helper", import.meta.url)), fileURLToPath(new URL("../workspace_tools/kintsugi-workspace-helper", import.meta.url)), platform);
