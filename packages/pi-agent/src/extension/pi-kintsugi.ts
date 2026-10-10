import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const configSchema = Type.Object({ url: Type.String(), token: Type.String(), turnSignalCommand: Type.String(), instructions: Type.String() });
type KintsugiSessionConfig = Static<typeof configSchema>;

/** Pi owns MCP discovery and execution; we only wire up the session. */
export function registerPiKintsugi(pi: ExtensionAPI, config: KintsugiSessionConfig): void {
  pi.registerMcpServer("kintsugi", {
    url: config.url,
    headers: { Authorization: `Bearer ${config.token}` },
    exposure: "codemode",
    timeout: 3_600,
  });

  // Append to Pi's assembled prompt so user prompt files and built-in guidance remain intact.
  pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${config.instructions}` }));

  async function signalTurn(boundary: "started" | "finished"): Promise<void> {
    const result = await pi.exec("sh", [config.turnSignalCommand, boundary]);
    if (result.code !== 0) throw new Error(result.stderr);
  }

  pi.on("agent_start", () => signalTurn("started"));
  pi.on("agent_end", () => signalTurn("finished"));
}

export default async function piKintsugiExtension(pi: ExtensionAPI): Promise<void> {
  const config = Value.Parse(configSchema, JSON.parse(await readFile(new URL("./config.json", import.meta.url), "utf8")));
  registerPiKintsugi(pi, config);
}
