import { expect, test } from "bun:test";
import { workspaceTemplateSecretAllowsPath } from "../src/secret-path-policy.ts";
import { workspaceTemplateSecretDefaultHosts } from "../src/secret-host-defaults.ts";

test("suggests hosts for well-known secret names and their aliases", () => {
  expect(workspaceTemplateSecretDefaultHosts("ANTHROPIC_API_KEY")).toBe("api.anthropic.com");
  expect(workspaceTemplateSecretDefaultHosts(" gh_token ")).toBe(workspaceTemplateSecretDefaultHosts("GITHUB_TOKEN"));
  expect(workspaceTemplateSecretDefaultHosts("MY_OWN_SECRET")).toBeUndefined();
});

test("Telegram's suggested host keeps its URL-path default", () => {
  expect(workspaceTemplateSecretAllowsPath({ hostPattern: workspaceTemplateSecretDefaultHosts("TELEGRAM_BOT_TOKEN")! })).toBe(true);
});
