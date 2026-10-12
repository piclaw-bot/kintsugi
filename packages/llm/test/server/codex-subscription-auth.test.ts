import { expect, spyOn, test } from "bun:test";
import * as workspace from "@kintsugi/workspace";
import { installClaudeSubscriptionAuth, installCodexSubscriptionAuth } from "../../src/server/subscription-cli.ts";

test("an app-owned Codex home receives only llm's OAuth placeholders", async () => {
  const exec = spyOn(workspace, "execWorkspaceCommand").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
  try {
    await installCodexSubscriptionAuth("workspace", "/private/codex", { listCredentials: async () => [{ providerId: "openai-codex", type: "oauth" }] });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![1].join(" ")).toContain("/private/codex/auth.json");
    const auth = JSON.parse(String(exec.mock.calls[0]![2]!.stdin));
    expect(auth.auth_mode).toBe("chatgpt");
    expect(auth.tokens.access_token).toBe("kintsugi-subscription-codex-access");
    expect(auth.tokens.account_id).toBe("kintsugi-subscription-codex-account");
    expect(auth.tokens.refresh_token).toBe("");
    expect(auth.OPENAI_API_KEY).toBeNull();
  } finally { exec.mockRestore(); }
});

test("an app-owned Claude config directory receives only llm's OAuth placeholders", async () => {
  const exec = spyOn(workspace, "execWorkspaceCommand").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
  try {
    await installClaudeSubscriptionAuth("workspace", "/private/claude", { listCredentials: async () => [{ providerId: "anthropic", type: "oauth" }] });
    expect(exec.mock.calls[0]![1].join(" ")).toContain("/private/claude/.credentials.json");
    const auth = JSON.parse(String(exec.mock.calls[0]![2]!.stdin));
    expect(auth.claudeAiOauth).toMatchObject({ accessToken: "kintsugi-subscription-anthropic-access", refreshToken: null });
    await expect(installClaudeSubscriptionAuth("workspace", "/private/claude", { listCredentials: async () => [{ providerId: "anthropic", type: "api_key" }] })).rejects.toThrow("Connect a Claude subscription");
  } finally { exec.mockRestore(); }
});

test("API keys and other providers cannot authorize a Codex subscription session", async () => {
  const exec = spyOn(workspace, "execWorkspaceCommand");
  try {
    await expect(installCodexSubscriptionAuth("workspace", "/private/codex", { listCredentials: async () => [{ providerId: "openai-codex", type: "api_key" }] })).rejects.toThrow("Connect a Codex subscription");
    await expect(installCodexSubscriptionAuth("workspace", "/private/codex", { listCredentials: async () => [{ providerId: "anthropic", type: "oauth" }] })).rejects.toThrow("Connect a Codex subscription");
    expect(exec).not.toHaveBeenCalled();
  } finally { exec.mockRestore(); }
});

test("workspace auth installation failures remain visible", async () => {
  const exec = spyOn(workspace, "execWorkspaceCommand").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "permission denied", durationMs: 1 });
  try {
    await expect(installCodexSubscriptionAuth("workspace", "/private/codex", { listCredentials: async () => [{ providerId: "openai-codex", type: "oauth" }] })).rejects.toThrow("permission denied");
  } finally { exec.mockRestore(); }
});
