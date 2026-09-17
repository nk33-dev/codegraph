---
title: Affected Tests in CI
description: Run only the tests a change actually touches.
---

`codegraph affected` traces import dependencies transitively to find which test files are affected by a set of changed source files — so CI can run only the relevant tests. Direct tests and high-confidence tests reached through a narrow dependency chain are returned by default. Candidates reached through broad shared modules are kept separate so a common entry point does not turn one change into the whole test suite.

```bash
codegraph affected src/utils.ts src/api.ts          # pass files as arguments
git diff --name-only | codegraph affected --stdin    # pipe from git diff
codegraph affected src/auth.ts --filter "e2e/*"      # custom test-file pattern
codegraph affected src/auth.ts --include-indirect    # inspect broad/low-confidence candidates
```

## Options

| Option | Description | Default |
|---|---|---|
| `--stdin` | Read the file list from stdin | `false` |
| `-d, --depth <n>` | Max dependency traversal depth | `5` |
| `--include-indirect` | Include candidates reached through broad/shared dependency chains | `false` |
| `-f, --filter <glob>` | Custom glob to identify test files | auto-detect |
| `-j, --json` | Output as JSON | `false` |
| `-q, --quiet` | Output file paths only | `false` |

## CI / hook example

```bash
#!/usr/bin/env bash
AFFECTED=$(git diff --name-only HEAD | codegraph affected --stdin --quiet)
if [ -n "$AFFECTED" ]; then
  npx vitest run $AFFECTED
fi
```
