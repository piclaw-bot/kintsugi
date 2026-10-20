import { AsyncLocalStorage } from "node:async_hooks";

const signals = /* @__PURE__ */ new AsyncLocalStorage<AbortSignal>();

/** Propagates cancellation through provisioning hooks without coupling them to the runner. */
export function withCommandSignal<T>(signal: AbortSignal, work: () => T): T {
  return signals.run(signal, work);
}

export function commandSignal(): AbortSignal | undefined {
  return signals.getStore();
}

/** Stop waiting for shared work without cancelling another workspace's operation. */
export async function waitForCommand<T>(work: Promise<T>): Promise<T> {
  const signal = commandSignal();
  if (!signal) return work;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([cancelled, work]); }
  finally { signal.removeEventListener("abort", abort); }
}

export class CommandOutputLimitError extends Error {
  constructor(limit: number) { super(`Command output exceeded ${limit} bytes on a pipe`); }
}

/** Kill the process group and reap it before reporting cancellation or output overflow. */
export async function runCommand(args: string[], options: { stdin?: string | Uint8Array; env?: Record<string, string | undefined>; cwd?: string; maxOutputBytes?: number } = {}): Promise<{ exitCode: number; stdout: Buffer; stderr: string }> {
  const signal = commandSignal();
  signal?.throwIfAborted();
  const { maxOutputBytes, ...spawnOptions } = options;
  if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)) throw new RangeError("Output limit must be a positive byte count");
  const proc = Bun.spawn(args, { ...spawnOptions, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
  async function capture(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    if (maxOutputBytes === undefined) return Buffer.from(await new Response(stream).arrayBuffer());
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of stream) { size += chunk.byteLength; if (size > maxOutputBytes) throw new CommandOutputLimitError(maxOutputBytes); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  const abort = () => killCommandGroup(proc.pid);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.stdin !== undefined) proc.stdin.write(options.stdin);
    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([capture(proc.stdout), capture(proc.stderr), proc.exited]);
    signal?.throwIfAborted();
    return { exitCode, stdout, stderr: stderr.toString("utf8") };
  } catch (error) {
    abort();
    await proc.exited;
    throw error;
  } finally { signal?.removeEventListener("abort", abort); }
}

/** A completed group is already stopped; other OS errors must surface. */
export function killCommandGroup(pid: number): void {
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
}
