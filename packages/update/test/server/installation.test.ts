import { expect, test } from "bun:test";
import { createInstallationClient } from "../../src/server/installation.ts";
import type { InstallationUpdate } from "@kintsugi/shared/installation-update";
const status: InstallationUpdate = { phase: "idle", message: "Current" };
test("installation client uses only the scoped supervisor protocol", async () => {
  const calls: { path: string, method: string, body: unknown }[] = [];
  const client = createInstallationClient(async (input, init) => {
    const path = new URL(String(input)).pathname; calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json(path.endsWith("capabilities") ? { installed: true, available: true } : status);
  });
  expect(await client.installed()).toBe(true); await client.check(); await client.prepare("plan-id"); await client.apply("plan-id"); await client.status();
  expect(calls).toEqual([
    { path: "/release/updater/capabilities", method: "GET", body: undefined },
    { path: "/release/updater/check", method: "POST", body: {} },
    { path: "/release/updater/prepare", method: "POST", body: { id: "plan-id" } },
    { path: "/release/updater/apply", method: "POST", body: { id: "plan-id" } },
    { path: "/release/updater/status", method: "GET", body: undefined },
  ]);
});
test("missing old capability routes mean app-only; installed but unavailable services never fall back", async () => {
  expect(await createInstallationClient(async () => new Response(null, { status: 404 })).installed()).toBe(false);
  const client = createInstallationClient(async input => String(input).endsWith("capabilities") ? Response.json({ installed: true, available: false }) : new Response(null, { status: 503 }));
  expect(await client.installed()).toBe(true); await expect(client.check()).rejects.toThrow("Host updater");
  await expect(createInstallationClient(async () => new Response(null, { status: 503 })).installed()).rejects.toThrow("availability");
});
test("invalid host state is rejected rather than passed through", async () => {
  await expect(createInstallationClient(async () => Response.json({ phase: "ready", message: "ready", plan: { id: "arbitrary", app: "untrusted:latest" } })).status()).rejects.toThrow();
});
