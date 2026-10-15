# Apt-layer evaluation

**Recommendation: keep Kintsugi’s existing four semantic apt layers. Do not adopt the global six-layer balancing algorithm unchanged.** It produces smaller maximum apt blobs, but Kintsugi already avoids upstream’s original giant layer. Global balancing weakens incremental caching and did not improve build time in this local trial.

## Baseline and proposal

Evaluated on 15 October 2026 against the current Kintsugi package manifest and [Pepijn Senders’s proposal, `821ef0be`](https://github.com/PepijnSenders/AgentsInTheCloud/commit/821ef0be87f79526b73985423130c97701d5fff6).

Kintsugi already groups its 56 requested base packages into four layers: general tools/system services (44), compilers/build tools (6), Pillow (1), and media tools (5). Commit `27e1c7a8` also removed several large scientific-Python packages. The proposal starts from an older upstream baseline with 61 requested packages in one large apt step; its original size/pull-time claims are not measurements of current Kintsugi.

The proposal divides the remaining apt install plan by `Installed-Size`, installs successive slices and restores dependency auto/manual marks. Build steps remain sequential. The intended parallelism is downloading independent registry layer blobs when pulling the resulting image.

## Local comparison

Two disposable ARM64 images used the same pinned runtime:

```text
ghcr.io/lucasmeijer/agents-in-the-cloud-docker@sha256:149efe3189255442091157921511b6c122b0254bb07e24d08d24408b4b79deda
```

- Baseline: the current four groups, each using the existing apt install command and cache mounts.
- Balanced: the same 56 requested packages flattened into the proposal’s six successive steps, using the reviewed `apt-layer.sh` from `821ef0be`.
- Only apt installation was built; no app, System, browser or editor setup was included. No image was published or installation changed.
- Package/version inventories and manual marks were queried in network-disabled containers. Docker’s OCI exporter supplied gzip layer descriptor sizes. The common inherited runtime layers are excluded below.

| Measurement | Current four groups | Proposed six balanced steps |
| --- | ---: | ---: |
| Added apt-layer gzip sizes, MiB | 109.00, 169.98, 5.78, 124.19 | 59.20, 66.30, 71.28, 102.96, 61.19, 48.51 |
| Total added apt gzip data, MiB | about 408.95 | about 409.43 |
| Largest added apt blob, MiB | 169.98 | 102.96 |
| Installed package/version entries | 490 | 490, identical |
| Manually marked packages | 145 | 145, identical |
| Observed initial build/export/load time | 148 seconds | 195 seconds |

Rounding can make displayed layer sums differ slightly from totals. The proposal reduced the maximum apt blob by about **39%**, while total apt download bytes increased by about **0.1%**. Installed package versions and manual marks matched exactly in this trial.

The build-time numbers are **single observations, not a controlled benchmark**. The balanced image ran second and could use warmed package caches; network timing and exporter work differed. They do not establish a general 32% slowdown. A later all-cache-hit export was used only to inspect OCI metadata, not as a build-time result.

## Current published image

An independent registry read of the published ARM64 workspace image `b81dd0294ae35281` showed base apt blobs of approximately **108.5, 170.0, 5.8 and 124.2 MiB**. That confirms the four-layer split is already deployed, not just proposed source.

The image also contains larger non-base-apt blobs: Playwright/browser setup about **404.2 MiB**, VS Code setup/extensions about **234.7 MiB**, and hunkdiff installation about **153.3 MiB**. Balancing the base apt install does not change those. No end-to-end cold registry pull was measured; registry bandwidth, concurrent-download limits, decompression and the storage driver can dominate the result.

## Trade-offs

- **Cache locality:** the current groups keep earlier tool layers unchanged when the media group changes; existing generator tests cover that boundary. The proposal puts the complete package list in every `RUN`, so adding one requested package invalidates all six steps from the first one. Applying it separately inside each semantic group would preserve boundaries but add more steps.
- **Size estimate:** apt `Installed-Size` is not compressed layer size. Shared dependencies, package scripts and compression affect actual blobs; equal installed-byte budgets do not guarantee equal downloads.
- **Build work:** six steps run apt update/planning more often than four. Sequential layer creation is not a parallel apt build.
- **Correctness:** package and manual-mark equality passed for this ARM64 package set. AMD64, multiarch packages, upgrades, removals, virtual packages and unusual apt metadata were not comprehensively tested. The helper’s dependency/upgrade bookkeeping deserves that matrix before adoption.
- **Maintenance:** semantic package groups are explicit and reviewable. The balancing helper adds apt-plan parsing and dependence on live repository metadata. Both approaches still use non-snapshot apt repositories; neither makes package resolution fully reproducible.
- **Integration:** current Kintsugi uses `aptPackageGroups`, while the proposal’s generator targets `aptPackages`. It requires adaptation rather than a mechanical replacement.

## Suggested next step

Leave production generation unchanged. If cold pulls are a practical problem, measure the full workspace image on fresh native AMD64 and ARM64 stores at representative bandwidth, then inspect the larger browser/editor blobs first. If apt remains significant, trial splitting only the compiler group or balancing within existing groups, preserving package-set/manual-mark and incremental-cache tests.

Raw inventories, OCI layer measurements, Dockerfiles and timing receipts are kept with this workspace’s `artifacts/apt-layer-evaluation/` and copied to `/persistent/kintsugi-audits/apt-layer-evaluation/`. Those receipts cover this local trial only, not a production or multi-architecture performance guarantee.
