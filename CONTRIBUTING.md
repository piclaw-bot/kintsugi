# Contributing to Kintsugi

**Kintsugi accepts direct pull requests.** You do not need to open an issue or receive an invitation before submitting a fix or improvement. Pull requests are reviewed for fit, correctness and maintainability; submission does not guarantee a merge.

## Kintsugi and upstream

Kintsugi is a fork of [AgentsInTheCloud](https://github.com/lucasmeijer/AgentsInTheCloud). We respect upstream’s [contribution policy](https://github.com/lucasmeijer/AgentsInTheCloud#contributing), including how its maintainers handle issues and pull requests. Upstream asks for descriptions of contributors’ own needs and accepts external pull requests as illustrations, without merging them.

Kintsugi has a different policy: **we welcome external pull requests for review and possible merge into this fork**. A contribution accepted here does not imply acceptance upstream. If you also submit an issue or pull request upstream, follow its current guidance and templates.

## Preparing a pull request

- Keep the change focused. Explain the problem, the approach and any compatibility effects.
- For a substantial feature or a security, networking or persisted-data change, consider opening an issue first to agree on scope. This is a recommendation, not a requirement for submitting a pull request.
- Read [AGENTS.md](AGENTS.md) and follow the repository’s implementation guidance and [UI testing policy](docs/ui-testing-policy.md).
- Describe how you verified the change and any limits on that verification. For UI changes, include screenshots or a manual acceptance report; do not add UI tests.
- Review and understand everything you submit, including generated code. Do not include credentials, private configuration or unrelated changes.

## Local checks

Use the locked dependencies and run:

```sh
bun install --frozen-lockfile
bun run check
bun run test
```

`bun run check` regenerates workspace modules before linting and type-checking. Follow `AGENTS.md` for any additional acceptance scripts required by your change.

## Attribution and licence

Preserve existing author credits, copyright notices, [LICENSE](LICENSE) and [NOTICE](NOTICE). Contributions are made under this repository’s MIT licence. When adapting someone else’s work, retain its attribution and identify the source commit or pull request.
