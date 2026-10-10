import { fileURLToPath } from "node:url";
import { writeCliSessionFiles, type CliAgentConnection, type CliAgentSession } from "@kintsugi/cli-agent/server";

export function piKintsugiExtensionPath(session: CliAgentSession): string {
  return `${session.directory}/pi-kintsugi/extension.mjs`;
}

let bundledExtension: Promise<string> | undefined;
function buildExtension(): Promise<string> {
  return bundledExtension ??= (async () => {
    const result = await Bun.build({
      entrypoints: [fileURLToPath(new URL("../extension/pi-kintsugi.ts", import.meta.url))],
      target: "node",
      format: "esm",
      minify: true,
      sourcemap: "none",
    });
    if (!result.success) throw new Error(`Could not bundle the pi-kintsugi extension: ${result.logs.map(String).join("\n")}`);
    return await result.outputs[0]!.text();
  })();
}

/** Install native instructions, MCP registration, and turn notifications with a session-private credential. */
export async function preparePiSession(workspaceId: string, session: CliAgentSession, connection: CliAgentConnection): Promise<Record<string, string>> {
  const extension = await buildExtension();
  const config = JSON.stringify({ ...connection, turnSignalCommand: session.turnSignalCommand });
  await writeCliSessionFiles(workspaceId, session, {
    "pi-kintsugi/extension.mjs": extension,
    "pi-kintsugi/config.json": config,
  });
  return {};
}
