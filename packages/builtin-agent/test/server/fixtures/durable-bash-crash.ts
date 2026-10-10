import { join } from "node:path";
import { shellQuote } from "@kintsugi/core";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { createDurableBashExtension } from "../../../src/server/durable-bash.ts";
import { openDurableWorkspace } from "../../../src/server/durable-workspace.ts";
import { localBashOperations } from "./bash-operations.ts";

const [path, socket] = process.argv.slice(2);
const operations = localBashOperations(join(path!, "receipts"), socket!);
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 100_000 });
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", {
  command: `echo once >> ${shellQuote(join(path!, "count"))}; sleep 1; echo recovered`, timeout: 10,
})], { stopReason: "toolUse" })]);
const registry = createRegistry();
registry.install(createDurableBashExtension("workspace", async (...args) => {
  const result = await operations(...args);
  if (args[0] === "ensure") {
    // Die after workspace admission, before the host receives its launch receipt.
    process.stdout.write("launched\n");
    await new Promise(() => {});
  }
  return result;
}));
const workspace = await openDurableWorkspace(join(path!, "journal"), "workspace", { models, registry });
const conversation = await workspace.agent({ agentId: "tab", label: "Agent 1", title: "Bash recovery" }, { model: { provider: "faux", modelId: "faux-1" } });
await conversation.submit({ type: "input", content: "Run", requestId: "one" }, BACKGROUND_CONTEXT);
setInterval(() => {}, 60_000);
