import { join } from "node:path";
import { Value } from "typebox/value";
import { bashOperationReceiptSchema, type BashOperations } from "../../../src/server/durable-bash.ts";

const script = join(import.meta.dir, "../../../workspace_tools/kintsugi-agent-bash");
export async function command(argv: string[]) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`${argv[0]} failed: ${stderr}`);
  return stdout;
}

export function localBashOperations(root: string, socket: string): BashOperations {
  return async (action, request, create = false) => {
    const argv = ["python3", script, action, JSON.stringify(request), "--root", root, "--socket", socket];
    if (create) argv.push("--create");
    return Value.Parse(bashOperationReceiptSchema, JSON.parse(await command(argv)));
  };
}
