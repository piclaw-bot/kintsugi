# Model update sync

A **model update sync** is an explicit review of Kintsugi's popular-model recommendations and a reset of its known-model baseline. It is not an automatic provider catalogue refresh.

## Before changing code

Describe, per popular provider:

1. **What is popular right now:** the ordered curated recommendations in `packages/llm/src/server/hardcoded-provider-knowledge.ts`, plus any available models automatically promoted because their IDs are absent from `packages/llm/src/server/shipped-provider-models.ts`.
2. **What we want to be popular:** the proposed ordered recommendations, showing additions, removals, and reordering. Explain the intended roles and tradeoffs using current catalogue information; distinguish catalogue facts from model-quality judgments.

Keep the legacy `openai-codex` recommendations aligned with OpenAI where its catalogue supports the same IDs. Cover the other popular providers, currently Anthropic, GitHub Copilot, and xAI, rather than silently resetting their baseline without reviewing their recommendations.

## Make the sync

Update these together:

- **Curated recommendations:** edit `hardcodedPopularModels` in `hardcoded-provider-knowledge.ts` to reflect the agreed order.
- **Known-model baseline:** replace the per-provider ID lists in `shipped-provider-models.ts` with all models currently known for those providers, not just recommended models or models available to one authenticated account. Use the current official Pi catalogues, including refreshed official catalogue data when available. Keep IDs unique and sorted; record the catalogue version/source in the file comment. Do not include user-defined custom models in this baseline.

Resetting the baseline makes today's models known. An automatically promoted model that should remain popular after the sync must therefore be included in the curated recommendations. Future IDs not in the new baseline will qualify for automatic promotion again.

Do **not** regenerate the baseline during startup or automatic catalogue refreshes: that would erase the distinction between known and newly discovered models.

## Selection rules to preserve

- Only models available to the connection can become setup defaults.
- Curated recommendations come first, in explicit order.
- IDs absent from the baseline for a popular provider come next, sorted by model ID.
- The combined default list has at most **five models per provider**. If more new models qualify, ID order determines which fit; it does not claim to rank their quality or recency.
- Known non-curated models are not automatically promoted. If no recommendations are available, the existing highest-known-input-price rule chooses one model.
- Providers without a baseline keep their existing price-based default behavior.
- Do not overwrite saved model selections or an active model. Default seeding still happens only when the user has no selections for that provider.

## Verify and report

Update the non-UI tests in `packages/llm/test/server/default-provider-models.test.ts` for the agreed curated order. Keep coverage for new-ID promotion, the five-model cap, deterministic ordering, unavailable models, and known non-curated models. Test through the recommendation functions, not UI markup.

Run:

```sh
bun test packages/llm/test/server/default-provider-models.test.ts packages/agent/test/server/model-preferences.test.ts
bun run check
```

Report the final ordered recommendations and confirm that the known-model baseline was refreshed in the same change.
