import { parseAgentNameCommand } from "./builtin-slash-commands.ts";

/** Kintsugi owns /name; providers supply only their conversation context and title store. */
export async function runAgentNameCommand(text: string, options: {
  suggest: () => Promise<string | undefined>;
  setTitle: (title: string) => Promise<void>;
}): Promise<"named" | "no-title" | undefined> {
  const command = parseAgentNameCommand(text);
  if (!command) return undefined;
  const title = command.title ?? await options.suggest();
  if (!title) return "no-title";
  await options.setTitle(title);
  return "named";
}
