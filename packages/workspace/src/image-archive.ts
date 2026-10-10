import { runCommand, shellQuote, withManagedDockerCommand } from "@kintsugi/core";

/** The archive stays in the pipe, not in Bun's heap or a temporary file.
 * Managed exec also stops the receiver inside the workspace on cancellation. */
export async function transferImageArchive(source: string[], destination: string[]): Promise<void> {
  await withManagedDockerCommand(destination.slice(1), async args => {
    const result = await runCommand(["bash", "-o", "pipefail", "-c", `${source.map(shellQuote).join(" ")} | ${["docker", ...args].map(shellQuote).join(" ")}`]);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Image archive transfer failed");
  });
}
