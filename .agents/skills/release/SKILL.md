---
name: release
description: Prepare and publish Kintsugi semantic-version releases through verified native GitHub Actions, preserving installation compatibility and channel policy.
---

# Release Kintsugi

Use the version-tagged GitHub Actions workflow in `docs/releases.md`. Do not copy upstream's `stable-<id>` tags, separate System-release procedure or SSH-first publishing instructions into this fork.

## Approval and scope

- Publishing requires an explicit user request. A request to implement, test, audit or sync upstream does not authorise a release.
- A release publishes app, System and workspace images, then advances `latest`. Leave `stable` unchanged unless the user separately authorises promotion after clean-install/update/rollback acceptance.
- Publication does not authorise restarting or updating an installation. Do not run the host installer against an existing installation as part of a release.
- Choose the requested semver increment from the latest published Kintsugi version. Do not move or delete an existing version tag to reuse it.
- Preserve unrelated concurrent changes. Release only committed, reviewed source; do not include another task's unfinished files.

## Prepare

1. Fetch origin and inspect the intended source, the current published release and the relevant diff. Check `git status`, remote main and existing tags.
2. Review `packages/shared/src/publishing.ts` for repositories and image source attribution. Existing custom update sources, pins and registry credentials remain authoritative; do not reset them.
3. Review `packages/shared/src/system-version.ts`. Check app minimum, System capability and persisted network-policy reader format. Optional features must be gated on running capability. Publish System support before raising an app minimum. Never copy upstream's counters into Kintsugi's independent namespace.
4. Update `apps/web/src/version.ts` and write user-facing notes under `release_notes/`. State verification limits, including blocked model, microphone, real-device or installation checks. Do not claim acceptance from a partial script or a fixture outside its scope.
5. Run `bun install --frozen-lockfile`, `bun run check`, relevant non-UI tests, `bun run test`, System dependency install/bundle build and actionlint. Use the existing acceptance scripts when required by AGENTS.md. No UI tests belong in the regular suite or CI.
6. Review the diff and commit the explicit verified files. Ordinary main pushes must remain CI-free. Push main, then create and push the authorised `vX.Y.Z` tag at that commit. The tag must match the version file and belong to main.

## Observe GitHub publication

- Watch `release.yml` with `gh run watch … -R rcarmo/kintsugi --exit-status`. Use the configured repository if working on another fork.
- Full CI runs once on AMD64. Native image jobs verify AMD64 and ARM64 execution, source/signature/compatibility labels, pinned workspace dependencies and the candidate app/System pair before publication.
- Immutable version tags are published before channel changes. Only the newest semver advances `latest`; services advance before the app. Channel changes are not atomic.
- Do not advance main during a release unnecessarily. A fast-forward does not change the tagged source; rewritten history is invalid. Never change an approved revision silently.
- On failure, inspect the actual job log before retrying. `gh api repos/OWNER/REPO/actions/jobs/JOB_ID/logs` can retrieve logs when `gh run view --log` is empty. Do not suppress failed checks or repeatedly rerun without a diagnosed cause.
- A failed response after registry writes is not proof of rollback. Inspect manifests/channels and rerun the same immutable publication only when safe. Do not run local and GitHub publishers concurrently.

## Verify and report

- Require successful release workflow completion, a non-draft GitHub Release, matching version/`latest` digests where promotion was intended, both native slices and compatibility labels.
- Replace generated GitHub notes with the reviewed notes and add the verification link. Record source SHA, channels moved, System capability/app minimum and any retry or acceptance limitation.
- Explicitly say that no installation was restarted unless a separate, authorised deployment actually occurred.

## Local tools

GitHub Actions is the normal publication path. Local commands require the existing opposite-architecture SSH builder and registry access; do not invent environment variables or provision an untrusted builder.

- `bun run release --check`: validate native builders; no publication.
- `bun run release --prepare --revision <full-sha>`: build/upload immutable app/workspace images and verify them; no channel change or GitHub Release.
- `bun run release --revision <full-sha>`: publish the pinned main-branch revision only when authorised. This legacy path publishes app/workspace images, not the paired installation workflow. It checks the target channel's System before promotion.
- `--stable` is an additional explicit approval, not a default. Do not use it simply because a GitHub Release is non-prerelease.

Read `docs/releases.md` for locks, logs, recovery and System/local-runtime tooling before invoking a local publisher.
