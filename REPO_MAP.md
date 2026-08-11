# Repository map

Read this before changing code.

Zede is an Electron terminal for Claude Code. It stores memory in local SQLite. Optional sync uses the user's git repo.

`CLAUDE.md` contains the managed `.zede/context.md` import. `AGENTS.md` only points to it. Do not copy the managed block into both files.

## Commands

```bash
pnpm dev           # development app
pnpm lint          # code style and React checks
pnpm test          # fast unit tests
pnpm typecheck     # TypeScript checks
pnpm selftest      # build and headless checks
pnpm check         # run every check
pnpm build:app     # install, rebuild, and package
pnpm run rebuild   # rebuild native modules for Electron
pnpm smoke:native  # test native modules
pnpm dist          # unsigned installer
pnpm dist:release  # signed arm64 and x64 installers
```

Use `pnpm run rebuild`, not `pnpm rebuild`.

## App layout

`src/shared/`
- `api.ts`: types used across IPC.
- `themes.ts`: terminal and app themes.

`src/preload/`
- `index.ts`: exposes `window.zede`.

`src/main/`
- `index.ts`: Electron entry and window.
- `core.ts`: owns the database, PTYs, capture, memory, and sync.
- `ipc.ts`: IPC handlers.
- `settings.ts`: validates local and synced settings.
- `selftest.ts`: project test suite.

`src/main/pty/`
- `manager.ts`: starts shells and batches output.
- `cwd.ts`: reads live process names and folders.
- `env.ts`: removes host-only flags and enables true color.

`src/main/capture/`
- `watcher.ts`: watches Claude transcripts.
- `parser.ts`: reads JSONL in bounded chunks.
- `binding.ts`: decides which session belongs to a tab.
- `internal.ts`: ignores Zede's own extractor sessions.

`src/main/db/`
- `database.ts`: opens SQLite and caches statements.
- `migrations.ts`: schema versions 1 through 9.
- `memories.ts`: all database queries.

`src/main/pipeline/`
- `redact.ts`: removes secrets.
- `fingerprint.ts`: makes stable hashes.
- `store.ts`: inserts, deletes, and restores memory.

`src/main/extract/`
- `claude.ts`: default `claude -p` extractor.
- `ollama.ts`: local Ollama extractor.
- `heuristic.ts`: local regex extractor.

`src/main/embed/`
- `embedder.ts`: hashing or MiniLM vectors.
- `service.ts`: embedding queue and superseding.

`src/main/retrieve/`
- `ranker.ts`: selects memory for a new session.

`src/main/inject/`
- `context.ts`: writes `.zede/context.md` and agent imports.

`src/main/sync/`
- `service.ts`: sync flow.
- `format.ts`: files stored in the sync repo.
- `merge.ts`: conflict rules.
- `crypto.ts`: optional encryption.
- `git.ts`: git commands.
- `githubAuth.ts`: GitHub device login.

`src/renderer/src/`
- `App.tsx`: main UI state.
- `app.css`: all app styles.
- `terminal/Terminal.tsx`: xterm pane.
- `terminal/ptyEvents.ts`: one routed PTY listener and inactive output buffer.
- `terminal/actions.ts`: clear command and dropped-path quoting.
- `tabs/TabBar.tsx`: tab list.
- `spaces/SpacesRail.tsx`: Space switcher.
- `memory/MemorySidebar.tsx`: prompts, internals, and memory.
- `memory/prompts.ts`: prompt filtering and newest-first order.
- `memory/MemoryDetail.tsx`: memory editor.
- `memory/InternalDetail.tsx`: skill and plugin editor.
- `settings/Settings.tsx`: app settings.
- `ui/shortcuts.ts`: platform-safe keyboard shortcuts.

`scripts/`
- Native smoke test and capture tools.

`test/`
- Fast unit tests for renderer helpers and PTY routing.

`.github/workflows/`
- Pull request checks and Windows release builds.

`eslint.config.mjs`
- Shared lint rules.

`landing/`
- Static website.

## Process rule

The renderer cannot use Node or SQLite.

Calls move through:

`renderer -> window.zede -> preload -> IPC -> Core`

Events move back through IPC.

Adding an API usually needs changes in:

1. `src/shared/api.ts`
2. `src/preload/index.ts`
3. `src/main/ipc.ts`
4. the caller

## Terminal rules

- Main owns PTYs. Closing a pane does not kill a PTY unless the user closes the tab.
- Do not use React Strict Mode. It can start a PTY twice.
- Claude must run with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`. Without it, scrollback and prompt jumps break.
- Remove inherited `NO_COLOR`, `FORCE_COLOR`, and agent-host flags. Set `TERM=xterm-256color` and `COLORTERM=truecolor`.
- Use `terminal/ptyEvents.ts` in renderer code. Do not add one bridge listener per pane.
- Inactive panes pause parsing. They keep up to 8 MiB of output per tab.
- Only the active pane uses WebGL.
- During a window or panel drag, do not fit xterm. Fit xterm and resize the PTY once when the drag ends.
- Idle shell tabs defer PTY resize signals because rich prompts append redraws on SIGWINCH. Apply the pending size when a foreground program starts.
- Command+K clears the active local xterm buffer.
- File drops use `webUtils.getPathForFile` in preload, then xterm bracketed paste with shell quoting.

## Capture rules

- Use recursive `fs.watch`. Do not replace it with chokidar. Chokidar used too many file handles.
- Watch failures retry with bounded backoff.
- Transcript paths are computed from the folder. The encoding is lossy. Never decode it.
- A project can be open in more than one Space. Session binding searches every Space; memory follows the bound tab.
- Read only complete JSONL lines.
- Each read is limited to 1 MiB. Live work has priority over backfill.
- Ignore `isMeta`, `isSidechain`, and non-user or non-assistant records.
- Read text blocks only.
- Mark extractor sessions before running `claude -p`.
- Run the extractor from a temporary folder.
- Redact before extraction, before storage, and before sync.

## Session rules

These are different:

- Capture: transcripts used to learn memory.
- Database binding: the conversation owned by a tab.
- Screen sessions: content shown in the current terminal buffer.

The prompt panel uses screen sessions only. Do not rebuild it from database bindings.

## Memory rules

- Core is the only database writer.
- Tombstones and audit logs are append-only.
- Hard delete keeps a tombstone.
- Archive does not create a tombstone.
- `edited_at` is the sync clock. Background scoring must not change it.
- `cc:` rows mirror Claude Code memory and survive reseeding.
- Prepared statements are shared. Do not change statement modes with `.pluck()`, `.raw()`, `.expand()`, or `.safeIntegers()`.

## Native build rules

`better-sqlite3` and `node-pty` are native modules.

Electron and system Node use different ABIs. Run:

```bash
pnpm install
pnpm run rebuild
pnpm smoke:native
```

Keep native modules external to the bundle. Package `.node` files outside the asar.

## Sync rules

- Sync order is fetch, import, export, commit, push.
- Missing files do not mean delete.
- Tombstones stop deleted memory from returning.
- `edited_at` decides the newest edit.
- Validate imported settings before saving them.
- The sync folder must be named `sync`.
- Deterministic encryption output is intentional. It keeps no-op syncs clean.

## Current limits

- Capture debounce: 4 seconds.
- Capture workers: 2, with at most 1 backfill worker.
- Capture read: 1 MiB.
- PTY output batch: 8 ms.
- Inactive PTY buffer: 8 MiB per tab.
- Terminal metric-change debounce: 160 ms.
- Prompt rows shown: 500.
- Screen sessions kept per tab: 25.
- Memory injection budget: about 1,500 tokens.
