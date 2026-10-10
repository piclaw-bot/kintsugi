import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { resolveWorkspace, workspaceContainerName, workspaceRoot } from "@kintsugi/workspace";
import type { CodexNotification } from "./protocol.ts";
import { CodexRpc } from "./rpc.ts";
import { codexVersion } from "./protocol.ts";

/** Stdio stays private: no listening port or raw provider credential in a workspace. */
export async function openCodexTransport(workspaceId: string, home: string, notification: (notification: CodexNotification) => void, failed: (error: Error) => void, mcp: { url: string; token: string }) {
  await resolveWorkspace(workspaceId);
  const executable = `/home/agent/.codex-cli/${codexVersion}/node_modules/.bin/codex`;
  const connectionOverride = `mcp_servers.kintsugi={url=${JSON.stringify(mcp.url)},required=true,tool_timeout_sec=3600,http_headers={Authorization=${JSON.stringify("Bearer " + mcp.token)}}}`;
  const process = Bun.spawn(["docker", "exec", "-i", "--user", "agent", "--workdir", workspaceRoot, "--env", `CODEX_HOME=${home}`, workspaceContainerName(workspaceId), executable, "-c", 'cli_auth_credentials_store="file"', "-c", connectionOverride, "app-server", "--listen", "stdio://"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let closing: Promise<void> | undefined;
  const rpc = new CodexRpc(line => { process.stdin.write(line); process.stdin.flush(); }, notification);
  let stderr = "";
  const stderrDecoder = new TextDecoder();
  const stderrDrain = (async () => {
    for await (const chunk of process.stderr) {
      stderr = (stderr + stderrDecoder.decode(chunk, { stream: true })).slice(-16000);
    }
    stderr = (stderr + stderrDecoder.decode()).slice(-16000);
  })();
  const lines = createInterface({ input: Readable.from(process.stdout), crlfDelay: Infinity });
  const reading = (async () => {
    try { for await (const line of lines) if (line.trim()) rpc.receive(line); }
    catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      rpc.fail(failure);
      if (!closing) failed(failure);
      process.stdin.end();
    }
  })();
  void process.exited.then(async code => {
    await stderrDrain;
    const error = new Error(`Codex app-server exited (${code})${stderr ? `: ${stderr}` : ""}`);
    rpc.fail(error);
    if (!closing) failed(error);
  });
  return { rpc, close() {
    return closing ??= (async () => {
      rpc.fail(new Error("Codex connection closed"));
      process.stdin.end();
      await process.exited;
      await reading;
      await stderrDrain;
    })();
  } };
}
