import { expect, test } from "bun:test";
import { getKintsugiRuntimeContext } from "@kintsugi/core";
import { resetKintsugiRuntimeContextForTests } from "../src/runtime-context.ts";

test.skipIf(process.platform !== "darwin")("Docker containers reach a native macOS Kintsugi through host.docker.internal", () => {
  resetKintsugiRuntimeContextForTests();
  expect(getKintsugiRuntimeContext().dockerBridgeHost).toBe("host.docker.internal");
  resetKintsugiRuntimeContextForTests();
});
