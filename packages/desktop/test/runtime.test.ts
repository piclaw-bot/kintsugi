import type { JsonObject } from "@kintsugi/core";
import { expect, test } from "bun:test";
import { createDesktopRuntime } from "../src/server/runtime.ts";

const running: import("../src/server/runtime.ts").RunningDesktop = { phase: "running", pid: 123, display: ":99", xauthority: "/home/agent/.local/state/kintsugi-desktop/Xauthority", cdpUrl: "http://127.0.0.1:9222", width: 800, height: 900 };
function result(status: JsonObject, exitCode = 0) { return { exitCode, stdout: JSON.stringify(status), stderr: "", durationMs: 1 }; }

test("desktop operations use the workspace-owned runtime, returning live connection details", async () => {
  const calls: unknown[] = [];
  const runtime = createDesktopRuntime(async (workspace, command) => { calls.push([workspace, command]); return result(running); });
  expect(await runtime.start("workspace")).toEqual(running);
  expect(await runtime.status("workspace")).toEqual(running);
  expect(calls).toEqual([ ["workspace", ["/opt/kintsugi/bin/kintsugi-desktop", "start"]], ["workspace", ["/opt/kintsugi/bin/kintsugi-desktop", "status"]] ]);
});

test("failed startup never returns CDP details as if ready", async () => {
  const runtime = createDesktopRuntime(async () => result({ phase: "failed", error: "Xvfb exited" }, 1));
  await expect(runtime.start("workspace")).rejects.toThrow("Xvfb exited");
  expect(await runtime.status("workspace")).toEqual({ phase: "failed", error: "Xvfb exited" });
});

test("missing workspace image dependency is surfaced", async () => {
  const runtime = createDesktopRuntime(async () => ({ exitCode: 127, stdout: "", stderr: "kintsugi-desktop: command not found", durationMs: 1 }));
  await expect(runtime.start("workspace")).rejects.toThrow("Recreate this workspace with the current workspace image. kintsugi-desktop: command not found");
});

test("invalid runtime output is not silently treated as stopped", async () => {
  const runtime = createDesktopRuntime(async () => result({ phase: "running" }));
  await expect(runtime.status("workspace")).rejects.toThrow();
});
