---
description: Align the app's vocabulary, CONTEXT.md, and source code through one naming decision at a time
---
Work with me to make CONTEXT.md correct, complete, and up to date, and ensure that everywhere in the code we use the same name for the same thing.

This is an interactive naming and consistency session, not just an audit or a proposal. Inspect the app, ask me to resolve naming decisions, and implement each agreed decision before moving on.

## Discover the vocabulary

Read the repository instructions, CONTEXT.md, and any applicable domain-modeling skill. Inspect the actual source code, user-facing copy, modes, workflows, tests, and existing documentation. Do not assume CONTEXT.md is already accurate or complete.

Build a working inventory of the app's features, modes, and concepts, including new or implicit concepts that have not been named yet. Look for:
- The same thing referred to by different names.
- One name used for different things.
- Vague, misleading, overloaded, or outdated names.
- Features, modes, or concepts missing from CONTEXT.md.
- Glossary entries that no longer match the app.
- Unclear distinctions or boundaries between related concepts.

Use concrete code references and scenarios to understand what each thing actually means. Do not invent distinctions merely because different identifiers exist, or merge distinct concepts merely because their names are similar.

## Ask one question at a time

Every decision turn must contain exactly one question, about either naming a concept or resolving an ambiguity. Always bring a recommended answer and briefly explain why it fits. Include just enough evidence or a concrete example for me to decide; do not dump the entire inventory or ask me to choose among unrelated decisions.

For a naming question, explain the concept and suggest a canonical name. For an ambiguity, explain the conflicting meanings or evidence and suggest how to resolve it. When the code and CONTEXT.md disagree, do not silently assume either is correct.

Wait for my answer before treating a proposed name or interpretation as approved. If my answer leaves the same issue ambiguous, ask one focused follow-up with a recommendation. Do not bundle additional questions into that follow-up.

Start with the highest-impact ambiguity or naming gap you discover, not a generic question about where to begin.

## Apply each decision

After each agreement:
- Update CONTEXT.md immediately with the canonical term and a clear definition, including distinctions from nearby concepts where useful. Keep it a glossary of the app's vocabulary, not an implementation log or a scratchpad.
- Make source code consistently use the agreed vocabulary: relevant types, symbols, files, UI labels, tests, comments, and documentation. Use normal casing conventions for each surface while preserving the same conceptual name.
- Remove obsolete aliases and misleading terminology where safe. Do not blindly replace matching words that refer to other concepts.
- Preserve behavior unless I explicitly approve a behavior change. If a rename affects a public API, external protocol, or persisted data, surface that consequence as the next single decision question with a recommendation before making a breaking change. Do not add speculative migrations or compatibility layers.
- Run relevant checks and search for leftover conflicting names. Follow the repository's testing policy.

Briefly report what was aligned, then continue inspecting and ask the next single question. Do not stop after the first batch: actively look for overlooked or newly introduced concepts throughout the app.

## Finish only when the vocabulary is aligned

The session is complete when every discovered app feature, mode, and concept has a clear canonical name; CONTEXT.md matches those concepts one-to-one without missing, stale, or duplicate entries; and the source code consistently refers to them using that vocabulary.

Perform a final coverage and consistency pass against the app and source, rather than declaring completion merely because the current question list is empty. Distinguish app concepts from incidental implementation details and third-party terminology; do not rename external vocabulary we do not control.

Finish with a concise summary of the agreed vocabulary changes and validation performed. State any unresolved decisions, unverified areas, or external naming constraints honestly; do not claim full alignment while gaps remain.
