# Zede native port — plan

Rewrite the Electron/TypeScript app as a native Rust binary with Zed-class
performance. This document is the working plan; `README.md` covers building.

## Why these pieces

| Concern | Choice | Why |
| --- | --- | --- |
| UI | `eframe`/`egui` on `wgpu` (Metal on macOS) | GPU-rendered, pure Rust, single static binary, no DOM/IPC between input and pixels. Rendering is isolated behind one widget, so a later GPUI swap stays possible. |
| Terminal engine | `alacritty_terminal` | Alacritty's own grid + VTE parser + scrollback + selection. The fastest proven Rust terminal core. |
| PTY | `portable-pty` (WezTerm's) | openpty on macOS/Linux, ConPTY on Windows — this alone dissolves the Windows blockers in the Electron app. |
| Storage | `rusqlite` (bundled SQLite) | SQLite compiled into the binary. The entire `electron-rebuild`/ABI-mismatch class of failure disappears. |
| Transcript watching | `notify` (FSEvents) | One watch handle for the whole tree; fd exhaustion impossible by construction (the chokidar lesson). |

## Performance budgets

- Cold start to interactive shell: < 300 ms
- Keypress → PTY write: same frame; PTY output → pixels: next vsync
- 60 fps under `yes`-style output floods (parsing happens off the UI thread)
- Idle CPU ≈ 0 (repaint only on PTY/UI events; cursor blink is the only timer)
- RSS < 100 MB with several live tabs

## Semantics ported from the TS app (load-bearing, do not drop)

- **Env rules** (`pty/env.ts`): strip `NO_COLOR`, `FORCE_COLOR`, `CURSOR_AGENT`,
  `CURSOR_CONVERSATION_ID`, `AGENT_TRANSCRIPTS`, `__CURSOR_SANDBOX_ENV_RESTORE`;
  set `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, `TERM=xterm-256color`,
  `COLORTERM=truecolor`, `TERM_PROGRAM=Zede`, `CLICOLOR=1`.
- **Spawn** (`pty/manager.ts`): POSIX claude tabs run
  `$SHELL -i -l -c 'claude --session-id <uuid>; exec $SHELL -il'` — `-i` is
  load-bearing (rc files → PATH → `claude` resolves); the session id is
  client-generated so the transcript path is deterministic. Resume uses
  `--resume <uuid>`; only verified UUIDs may reach the command string.
  Windows: PowerShell `-NoLogo [-NoExit -Command …]`.
- **Resize deferral**: idle shell tabs defer SIGWINCH (rich prompts append
  redraws); apply the pending size when a foreground program produces output.
- **Transcript paths** (`capture/paths.ts`): lossy forward-only cwd encoding
  (every non-alphanumeric → `-`) under `~/.claude/projects/`; never decode.
- **Pinned-tab restore**: pinned claude tabs resume `last_session_id` on first
  spawn after launch, gated by the `restorePinnedSessions` setting.
- **Settings** (`settings.ts`): same keys, ranges and string storage form.
- **Themes** (`themes.ts`): all five themes, terminal palette + chrome tiers.
- Cmd+K clears the local buffer only. File drops paste shell-quoted paths.

## Phases

- **P0 — scaffold**: branch, toolchain, crate, plan. ✅
- **P1 — terminal core**: one pane; spawn login shell; grid/cursor/color
  rendering; keyboard encoding (incl. app-cursor mode, bracketed paste);
  resize; scrollback scrolling; selection + clipboard; exit overlay.
- **P2 — app shell**: Spaces rail, tab sidebar, per-tab PTY sessions that
  survive Space switches, ⌘T/⌘W/⌘1–9, pinning, layout persisted in SQLite.
- **P3 — settings**: theme picker, font size / line spacing / letter spacing /
  scrollback / cursor style / blink, restore toggle; live apply; SQLite-backed.
- **P4 — claude tabs**: session-id spawn, env rules, deterministic transcript
  path recorded per tab, pinned-tab `--resume` on relaunch.
- **P5 — capture + prompts**: bounded JSONL parsing (1 MiB reads, complete
  lines only, meta/sidechain/text-block filters) + prompt navigator in the
  sidebar (click to copy; first prompt auto-titles a default-named chat). ✅
  Claude-tab transcript paths are deterministic, so the navigator polls one
  file per chat (2s stat) — the `notify` watcher over `~/.claude/projects`
  is only needed for cross-session memory capture and moves to P6.
- **P6 — memory pipeline**: schema (memories + append-only tombstones,
  column-compatible with the Electron v6 shape), secret redaction (ported
  rule-for-rule), memory sidebar (⌘M: search, pin, forget), and the one-way
  read-only Electron importer (UI button + `zede --import-electron`;
  verified against the real db: 2,415 memories). ✅
  Remaining: extraction (`claude -p` / heuristic over captured spans, using
  the P5 parser + redaction), the `notify` watcher for sessions Zede didn't
  spawn, and the `.zede/context.md` injection writer.
- **P7 — sync**: git-backed sync port (device-flow auth, merge rules,
  tombstones, optional encryption).
- **P8 — packaging**: `.app` bundle + icon + dmg; CI matrix (macOS arm64/x64,
  Windows — ConPTY comes free, Linux); release docs.

P1–P5 are implemented in this crate now; P6+ have seams (`db` schema fields,
session ids, transcript paths, the capture parser) already in place.

## Deliberate v1 gaps

- No mouse reporting to TUI apps (wheel falls back to arrow keys on the alt
  screen); no kitty keyboard protocol; no IME composition preview (commits
  work); no ligatures. All are additive later.
- Fonts: bundled Hack, plus auto-load of an installed Nerd Font (Meslo/
  JetBrains/Fira/Hack NF) so powerline prompts render; a font-family picker
  needs a font-discovery pass (later).
