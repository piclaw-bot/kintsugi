# Agent instructions

## Implementation guidelines

Do not write UI tests. Follow the [UI testing policy](docs/ui-testing-policy.md).

- Do not add documentation files unless explicitly requested.
- When working on the web app, prefer server-rendered HTML over client-rendered UI.
- Prefer Turbo Frames and Turbo Streams for webpage/server interactions whenever possible.
- Have endpoints return server-rendered HTML or `text/vnd.turbo-stream.html` responses instead of JSON that client JavaScript turns into DOM.
- Use client JavaScript only for behavior that cannot reasonably be expressed server-side, such as WebSocket terminals, focusing/activating views, dialogs, or browser-only APIs.
- When JavaScript is necessary, implement it as Stimulus controllers rather than inline scripts or ad-hoc global event listeners.
- Keep Stimulus controllers small and behavior-focused; keep markup generation on the server.
- Be very reluctant in implementing fallbacks or migrations.  The only area that warrants migrations is kintsugis ability to not crash when loading older persisted files like settings, workspace settings etc
- Do not use defensive programming.  We don't want to swallow errors, we want to notice them. Only be defensive when parsing external inputs.
- Never add a new environment variable to the codebase without explicit instructions to do so. We're striving for minimal configuration, and minimal environment variables.
- Run `bun run generate:workspace-modules` before raw TypeScript checks; otherwise missing ignored generated modules cause cascading unrelated server errors.
- When presenting the user with the results after an implementation request, if kintsugi itself is the most natural place to showcase your change to the user, run kintsugi, show it in the preview browser, and use api's you can find in our openapi description to bring the inner kintsugi to a state/situation where
- your work can immediately be evaluated, without the user having to do more manual preparation steps.
- It’s okay to incur modest inference costs to stage and verify a real Agent session when presenting work.
- Kintsugi running inside Kintsugi automatically receives the outer Kintsugi’s model-provider credentials; don’t assume it needs separate setup.
- When controlling or staging an Kintsugi instance programmatically, follow [docs/automation.md](docs/automation.md).
- Whenever modifying the user interface, use elements from the [Kintsugi design system catalogue](packages/design-system/README.md) whenever possible.

### Composer and soft-keyboard acceptance scripts

- Changes touching the composer, transcript scroll, floating buttons or terminal sizing must run `acceptance/composer-layout.ts`.
- Changes touching soft-keyboard handling must also run `acceptance/soft-keyboard.ts`.
- In both cases, link the report in the summary.

Run the development server with `bun run web`. It watches TypeScript, CSS, assets, and server code, automatically reloading open pages after successful changes. Successful asset reloads log `[assets] ready`.

## User-facing copy and dialogs

Follow these guidelines whenever writing or changing user-facing text, panels, or dialogs.

### Copy

- Be friendly, helpful, informal, and lighthearted.
- Before writing user-facing text, put yourself in the user’s shoes. Consider what they know, what they’re trying to do, and what message would help them in that moment.
- Use as little writing as gets the job done, in the simplest language that remains accurate.
- Explain consequences plainly. Say what will close, change, or be lost. For warnings, distinguish expected situations from possible problems.
- Keep information relevant to the current task. Omit unnecessary reassurance and put special-case instructions where they’re needed.

### Panels and dialogs

- Use the fewest headings needed to orient the user. A simple dialog usually needs one title, not a title plus a body heading.
- Give each element a distinct job: the title orients, the body adds context or consequences, labels identify content, and buttons offer actions. Avoid repeating the same message across them.
- Write for the person using the app—not the person requesting the implementation. Apply requirements silently; don’t turn implementation commentary into app copy.
- Make button labels understandable in context. Explicit action labels are useful, but conversational labels can work too.
