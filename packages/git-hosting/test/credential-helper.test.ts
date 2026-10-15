import { describe, expect, test } from "bun:test";
import { gitCredentialHelperShellBody, gitHostingShorthandUrl } from "../src/index.ts";

async function runCredentialHelper(input: string, env: Record<string, string> = { GH_TOKEN: "github-secret" }): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", gitCredentialHelperShellBody, "kintsugi-git-credential", "get"], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

describe("git credential helper", () => {
  test("offers each token only to its own HTTPS host", async () => {
    expect(await runCredentialHelper("protocol=https\nhost=github.com\n\n")).toBe("username=x-access-token\npassword=github-secret\n");
    expect(await runCredentialHelper("protocol=https\nhost=github.com:443\n\n")).toBe("username=x-access-token\npassword=github-secret\n");
    expect(await runCredentialHelper("protocol=https\nhost=example.com\n\n")).toBe("");
    expect(await runCredentialHelper("protocol=https\nhost=github.com.evil.test\n\n")).toBe("");
    expect(await runCredentialHelper("protocol=ssh\nhost=github.com\n\n")).toBe("");
  });

  test("stays quiet when the provider is not connected", async () => {
    expect(await runCredentialHelper("protocol=https\nhost=github.com\n\n", {})).toBe("");
  });

  test("ignores store and erase requests", async () => {
    const proc = Bun.spawn(["sh", "-c", gitCredentialHelperShellBody, "kintsugi-git-credential", "store"], { env: { GH_TOKEN: "github-secret" }, stdin: "pipe", stdout: "pipe" });
    proc.stdin.write("protocol=https\nhost=github.com\n\n");
    proc.stdin.end();
    expect(await new Response(proc.stdout).text()).toBe("");
  });
});

test("expands provider shorthand to HTTPS URLs", () => {
  expect(gitHostingShorthandUrl("github.com/org/repo")).toBe("https://github.com/org/repo");
  expect(gitHostingShorthandUrl("GitHub.com/org/repo#main")).toBe("https://GitHub.com/org/repo#main");
  expect(gitHostingShorthandUrl("example.com/org/repo")).toBeUndefined();
});
