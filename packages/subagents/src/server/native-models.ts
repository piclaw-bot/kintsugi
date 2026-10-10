import { isJsonObject } from "@kintsugi/core";
import type { Models } from "@earendil-works/pi-ai";
import { GenerationTask, hook, type Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { attribution, Delegation, updateReceipt } from "./native-state.ts";
import { SubagentModelInput } from "./subagent-model-input.ts";

/** Request identity is ephemeral. A history fork may replay an ancestor's message,
 * but must never drain that ancestor's mailbox or rewrite its delivery evidence. */
export const delegationRequestIdentity = hook(GenerationTask, {
  beforeRequest(request, api) {
    return { messages: request.messages.map(message => {
      const part = attribution(message);
      if (!part) return message;
      return { ...message, content: [{ ...part, kintsugiAgentMessage: { ...part.kintsugiAgentMessage, requestConversationId: api.conversationId } }] };
    }) };
  },
});

/** A workspace-lifetime adapter with conversion state private to each stream call. */
export function delegationModels(models: Models, harness: () => Harness): Models {
  const streamSimple: Models["streamSimple"] = (model, request, options) => {
    const bridge = new SubagentModelInput();
    const delivered = request.messages.flatMap(message => {
      const part = attribution(message);
      return part ? [part.kintsugiAgentMessage] : [];
    });
    const messages = request.messages.map(message => {
      const part = attribution(message);
      if (!part) return message;
      return bridge.forModel({ type: "agent_message", author: part.kintsugiAgentMessage.author, recipient: part.kintsugiAgentMessage.recipient, content: [{ type: "input_text", text: part.text }] }, model.api, message.timestamp);
    });
    return models.streamSimple(model, { ...request, messages }, {
      ...options,
      async onPayload(payload, selected) {
        const previous = await options?.onPayload?.(payload, selected);
        // Provider objects may contain undefined option fields; validate their wire representation.
        const wire = JSON.parse(JSON.stringify(previous ?? payload));
        if (!isJsonObject(wire)) throw new Error("Expected a provider request object");
        const transformed = bridge.transform(wire, model.api);
        if (delivered.length) await harness().commit(async tx => {
          const ledger = await tx.doc(Delegation);
          for (const marker of delivered) {
            const receipt = ledger.receipts[marker.id];
            // Inherited context is not a new receipt, and never drains another branch's mailbox.
            if (!receipt || marker.requestConversationId !== marker.conversationId || receipt.conversationId !== marker.conversationId || receipt.prepared) continue;
            await updateReceipt(tx, receipt.id, { prepared: { timestamp: Date.now(), format: model.api === "openai-codex-responses" ? "agent_message" : "user envelope" } });
          }
        }, { ...BACKGROUND_CONTEXT, abortSignal: options?.signal });
        return transformed;
      },
    });
  };
  // ModelRuntime implements these as prototype methods; spreading it drops them.
  // Preserve its receiver (provider/auth state) while replacing native chat paths.
  return {
    getProviders: models.getProviders.bind(models),
    getProvider: models.getProvider.bind(models),
    getModels: models.getModels.bind(models),
    getModel: models.getModel.bind(models),
    getModelsOfType: models.getModelsOfType.bind(models),
    getModelOfType: models.getModelOfType.bind(models),
    getAllModels: models.getAllModels.bind(models),
    refresh: models.refresh.bind(models),
    checkAuth: models.checkAuth.bind(models),
    getAvailable: models.getAvailable.bind(models),
    getAvailableOfType: models.getAvailableOfType.bind(models),
    getAllAvailable: models.getAllAvailable.bind(models),
    getAuth: models.getAuth.bind(models),
    login: models.login.bind(models),
    logout: models.logout.bind(models),
    stream: models.stream.bind(models),
    complete: models.complete.bind(models),
    streamDeferred: models.streamDeferred.bind(models),
    fetchDeferred: models.fetchDeferred.bind(models),
    cancelDeferred: models.cancelDeferred.bind(models),
    generateImages: models.generateImages.bind(models),
    classify: models.classify.bind(models),
    streamSimple,
    completeSimple: (model, request, options) => streamSimple(model, request, options).result(),
  };
}
