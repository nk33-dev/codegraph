# CodeGraph maintenance workflow

This document describes the sync, verification, data recovery and release boundaries of the personal fork. For implementation details see the [development reference](../development.md), and for personal features see the [navigation](README.md).

## 1. Branches and sync preparation

- `origin` is the personal fork: `https://github.com/nk33-dev/codegraph`; `upstream` is the official repository: `https://github.com/colbymchenry/codegraph.git`, with pushing to upstream disabled locally.
- `main` only fast-forwards the official history; `personal` maintains personal features. Remote branches and the GitHub default branch must be verified after pushing; creating a branch locally does not change them automatically.
- Keep the working tree clean, and preserve the original personal commits, the verified upstream baseline, the target upstream commit/version and the test results. A common ancestor cannot replace verification records, and cherry-picks or partial migrations are marked separately.
- Compare the complete diff from baseline to target, then check it against the personal differences; cover additions, removals, deprecations, security fixes, renames, dependency/lock files and CI, not just the conflict list or the release notes.

## 2. Merge and refactor migration

After fast-forwarding main, create a sync branch from personal; a major version or overlapping refactors must be verified in isolation. The following is a step example, and the placeholders must be replaced with the actual target:

```text
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch personal
git switch -c codex/sync-<version-or-commit>
git merge --no-commit --no-ff main
```

If main cannot fast-forward, find out why first and do not force-overwrite history. A conflict-free automatic merge must also complete the following checks:

1. Migrate new upstream behavior according to the current module ownership; the old inline implementation and the split module must not execute at the same time, and new callers must go through the same entry point.
2. For overlapping changes, record the basis for keeping, migrating, already covering or deferring them; removals and security fixes must be applied to the personal modules as well, and the old defects must not remain.
3. Trace the old entry points and check for duplicate MCP registrations, file watchers, timers, index tasks and processes. If adopting the new upstream architecture is more appropriate, adjust the ownership and the mapping first, then delete the superseded paths.

When refactoring, record the following in the corresponding feature document:

| Old upstream file/symbol | Current module/symbol | Single call or registration entry point | Behavior contract | Regression test |
| --- | --- | --- | --- | --- |
| Fill in per the actual refactor | Current runtime location | Who calls it, when it registers | Inputs/outputs and lifecycle | Reproducible behavior check |

An old entry point is only the basis for migration. An uncommitted merge can be abandoned with `git merge --abort`; after verification, merge back into personal, keeping the upstream merge ancestor, without squashing the whole sync and without force-resetting shared history.

## 3. Compatibility and recovery checks

Check according to the impact scope of this change, and do not assume that not-yet-implemented LSP capabilities already exist:

| Scope | Key checks |
| --- | --- |
| CLI/MCP | arguments, output, tool schema, compatibility of old clients with the new service; tool documentation is still maintained by the existing entry point |
| Index and configuration | database version, cache invalidation, upgrade and old-version read capability; distinguish a rebuildable index from user configuration |
| watcher/daemon | duplicate tasks, exit cleanup, isolation of stale responses; projects/worktrees do not share state, and exiting one client does not wrongly stop the others |
| Future LSP integration | language server version, file sync, multi-window reuse, reconnect after failure; behavior tests are added when the feature lands |
| Installation and distribution | Node runtime, platform packages, asset manifest, download URLs, update source, npm scope, tags and workflow write-back branches |

For persistent format changes, first verify upgrade, repeated startup, interrupted migration and failure recovery on a copy, using a consistent database backup. Do not clear the user directory to bypass migration, and do not experiment on the only copy of the data. A Git rollback is not the same as a data downgrade; record whether the old version can read the new format and the backup-restore or forward-fix approach.

## 4. Verification and merging back

- Run `npm run build` and `npm test` before and after the merge; run the relevant evaluations per module, and follow the [validation methodology](../validation.md) for new languages/frameworks.
- Regression coverage spans the scenarios that trigger upstream fixes and the personal features; check call counts, routing and cleanup behavior, since searching the source cannot replace running verification.
- Verify the actual CLI/MCP path, source commit and build version, so that a globally installed old npm version does not mask local results. Installer or package-structure changes require verifying the packaged artifacts, not just the source directory.
- Check Windows, Linux and macOS differences against the actual environments, and do not carry over the upstream maintainer's machine assumptions. Distinguish baseline failures, new failures and unverified items, and do not write a failing check as passing.
- Merge back into personal and update the verified baseline only after the necessary checks are complete. An upstream major release does not mean the personal version is already compatible, and these rules are not the same as automated semantic conflict detection.

## 5. Records and documentation

The sync commit description or PR records: the original personal commits, the verified baseline and the target commit/version; the overlapping module mapping and where it was handled; the check commands, results, platform, actual artifacts and final verification commit; the migration/recovery basis, deferred items and limitations.

Long-lived entry points and contracts are written into the corresponding feature documents and updated as the feature changes, and historical entry points are not listed as the current implementation. Navigation does not pile up operation logs, and records contain no credentials or user source code text.

## 6. Personal release

- The project name stays CodeGraph, without carrying over version suffixes from other projects; the version policy, npm scope and personal release process are settled before the first release, and the version and package name are not changed on our own initiative.
- The existing upstream mechanism includes an npm shim, platform packages and runtime bundling; when changing the release process, read the [upstream release reference](../upstream-release.md), and do not replace the whole release with a direct `npm publish` of the root package.
- First verify your own package name, download repository, update source and workflow write-back branch; do not revert to the upstream release target or write personal release commits to main.
- GitHub commands explicitly specify `--repo nk33-dev/codegraph`; disabling upstream's pushurl does not prevent mistaken gh operations. Commits, pushes, tags and releases are performed as authorized by the user.
- Plan, implementation, verification and release are described separately, and a successful release does not mean installation and running have been tested in practice.
