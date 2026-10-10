import { listKintsugiProcesses, sortKintsugiProcesses } from "./processes.ts";

const termWaitMs = 1_000;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const matches = await listKintsugiProcesses({ excludePid: process.pid });
  if (matches.length === 0) {
    console.log("No Kintsugi web servers found.");
    return;
  }

  const ordered = sortKintsugiProcesses(matches);

  for (const proc of ordered) {
    console.log(`Stopping Kintsugi ${proc.kind} process ${proc.pid}: ${proc.command}`);
    signal(proc.pid, "SIGTERM");
  }

  await sleep(termWaitMs);

  const stubborn = ordered.filter((proc) => isRunning(proc.pid));
  for (const proc of stubborn) {
    console.log(`Force killing Kintsugi ${proc.kind} process ${proc.pid}`);
    signal(proc.pid, "SIGKILL");
  }

  console.log(`Stopped ${ordered.length} Kintsugi process${ordered.length === 1 ? "" : "es"}.`);
}

await main();
