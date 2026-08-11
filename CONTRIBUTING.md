# Contributing

## Setup

You need Node 22+, pnpm, and the `claude` CLI.

```bash
pnpm install
pnpm run rebuild
pnpm dev
```

Read [REPO_MAP.md](REPO_MAP.md) before changing code.

## Checks

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm selftest
```

Keep pull requests small. Open an issue before a large change.

## Builds

```bash
pnpm build:app   # local macOS app
pnpm dist:dir    # unpacked app
pnpm dist        # unsigned installer
```

Windows builds must run on Windows because native modules cannot be cross-built.

Signed macOS releases use:

```bash
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=...
export APPLE_ID=...
export APPLE_APP_SPECIFIC_PASSWORD=...
export APPLE_TEAM_ID=...
pnpm dist:release
```

The GitHub sign-in flow uses the app id in `src/main/sync/githubAuth.ts`. Forks need their own GitHub App. Git CLI sync works without one.

Contributions use the MIT license.
