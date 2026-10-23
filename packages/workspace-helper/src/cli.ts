#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * Runs a workspace process from a host terminal, the way `docker exec -it` did.
 * Usage: cli.ts <socket> <identity-directory> <user> <workdir> <argv...>
 */
import { configureWorkspaceHelperIdentity, exitStatus, startWorkspaceProcess } from "./index.ts";

const [socket, identityDirectory, user, workdir, ...argv] = process.argv.slice(2);
function usage(): never {
  console.error("usage: cli.ts <socket> <identity-directory> <agent|root> <workdir> <argv...>");
  process.exit(2);
}
if (!socket || !identityDirectory || !workdir || argv.length === 0) usage();
if (user !== "agent" && user !== "root") usage();

configureWorkspaceHelperIdentity(socket, readFileSync(join(identityDirectory, "cert.pem")), readFileSync(join(identityDirectory, "key.pem")));
const terminal = process.stdin.isTTY;
const size = () => ({ cols: process.stdout.columns, rows: process.stdout.rows });
const child = startWorkspaceProcess(socket, { argv, user, workdir, terminal: terminal ? size() : undefined });
if (terminal) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (data: Buffer) => child.write(data));
  process.stdout.on("resize", () => child.resize(size()));
}
// A hangup, e.g. from killing this terminal, ends the remote process too.
process.on("SIGHUP", () => child.cancel());
process.on("SIGTERM", () => child.cancel());

const copy = async (stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) => {
  for await (const chunk of stream) target.write(chunk);
};
await Promise.all([copy(child.stdout, process.stdout), copy(child.stderr, process.stderr)]).catch(() => {});
try {
  process.exit(exitStatus(await child.exited));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(255);
}
