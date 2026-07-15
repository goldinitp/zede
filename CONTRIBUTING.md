# Contributing to Zede

Thanks for helping out. Here's everything you need.

## Setup

You need Node 22+, [pnpm](https://pnpm.io), and the `claude` CLI on your PATH.

```bash
pnpm install
pnpm rebuild     # rebuilds native modules (better-sqlite3, node-pty) for Electron
pnpm dev         # starts the app in development
```

## Before you open a PR

Run these two commands — both must pass:

```bash
pnpm typecheck
pnpm selftest
```

That's the whole checklist.

## Ground rules

- **Big change? Open an issue first** so we can agree on direction before you spend time on it.
- **Small fix (typo, bug, docs)?** Just send the PR.
- Keep PRs focused on one thing.

## Where things live

| Path | What it is |
|---|---|
| `src/main/` | Electron main process — PTY, database, sync, session management |
| `src/preload/` | The IPC bridge between main and renderer |
| `src/renderer/` | The React UI |
| `src/shared/` | Types and helpers used by both sides |
| `landing/` | The website (zede.dev) |
| `docs/` | Design notes and packaging docs |

## One gotcha

The in-app "Sign in with GitHub" needs a registered GitHub App client id (see the README). You don't need it to develop — the gh CLI and git-remote sync options work without it, and everything else in the app is fully local.

## License

MIT. By contributing, you agree your contributions are licensed under it too.
