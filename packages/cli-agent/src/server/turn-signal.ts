import { shellQuote } from "@kintsugi/core";

/** Turn boundary reported to Kintsugi: a started turn marks the Agent busy, a finished or failed one requests attention for it. */
export type TurnBoundary = "started" | "finished" | "failed";

/** Every session gets one signal script, invoked as `sh <script> <boundary>`. */
export function turnSignalArgv(command: string, boundary: TurnBoundary): string[] {
  return ["sh", command, boundary];
}

/** The same invocation for CLIs that take a shell command line rather than an argument vector. */
export function turnSignalShell(command: string, boundary: TurnBoundary): string {
  return `sh ${shellQuote(command)} ${boundary}`;
}
