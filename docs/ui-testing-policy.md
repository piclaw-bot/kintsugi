# UI testing policy

Do not write UI tests.

This prohibition includes:

- browser-driven interaction, layout, and visual-regression tests;
- DOM-rendering or simulated-browser tests;
- server-rendered HTML assertions whose purpose is to verify UI markup;
- snapshots of UI output; and
- client unit tests whose purpose is to verify presentation or interaction behavior.

Do not replace a removed UI test with equivalent coverage at another UI test layer. Validate UI changes by running Kintsugi and reviewing the affected behavior manually.

Tests for non-UI domain logic, server behavior, and protocols remain appropriate. When a feature is exposed through the UI, test the underlying non-UI operation only when that operation has a useful interface independent of its presentation. Do not extract implementation details or create artificial interfaces solely to make UI behavior testable.

**Exception: acceptance scripts.** Scripts in `acceptance/` that drive a running Kintsugi and write a report are allowed. They're run by hand or by an agent and are never part of a test suite or CI. They must check user-visible invariants (one-step transitions, no terminal resizes, push-up placement), not markup, selectors or implementation details.
