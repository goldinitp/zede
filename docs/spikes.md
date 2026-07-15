# M0 — Spike findings

Empirical results from the M0 de-risking spikes. These are the load-bearing facts the M1 build relies on. All verified on this machine (macOS, darwin 25.4) on 2026-06-24.

> TL;DR — **all M0 risks retired.** node-pty + better-sqlite3 load and work under Electron's ABI; an xterm pane runs interactive `claude` end-to-end; transcript binding is deterministic via `--session-id`; the incremental watermark reads only-new records; `claude -p --json-schema` yields schema-valid structured memories. The two surprises worth carrying forward: **(1)** Electron 42 bundles **Node 24 (ABI 146)** so native modules must be electron-rebuilt and won't load under system `node`; **(2)** a cold `claude -p` extraction is **~25 s / $0.33**, so the real extractor must pin a cheap model + batch.

---

## Environment / locked stack

| Thing | Value |
|---|---|
| OS / Node (system) / npm | macOS darwin 25.4 · Node 22.22.3 · npm 10.9.8 |
| Xcode CLT · python (node-gyp) | `/Library/Developer/CommandLineTools` · Python 3.9.6 — present ✓ |
| `claude` CLI | 2.1.187 at `~/.local/bin/claude` |
| Rust · Ollama | **absent** (not needed for Electron path / `claude -p` tier) |
| Electron | **42.5.0** → bundles **Node 24.17.0**, module **ABI 146** |
| electron-vite · vite · plugin-react | 5.0.0 · **7.3.5** · **5.2.0** |
| React · TypeScript | 19.2 · **6.0.3** |
| better-sqlite3 (SQLite) · node-pty | 12.11.1 (**SQLite 3.53.2, FTS5 ✓**) · 1.1.0 |
| @xterm/xterm · addon-fit | 6.0 · 0.11 |

### Dependency pin that matters
`vite@8` + `@vitejs/plugin-react@6` are too new for `electron-vite@5` (peer `vite ^5||^6||^7`). **Pin `vite@^7` + `@vitejs/plugin-react@^5.2.0`.** Don't `--legacy-peer-deps` past this; it's a real incompatibility.

### TS 6 gotchas hit during scaffolding
- `baseUrl` is a hard **error** in TS 6 (deprecated for 7.0). Use `paths` **without** `baseUrl`, and make path targets relative (`"@shared/*": ["./src/shared/*"]`).
- React 19 removed the global `JSX` namespace. Don't annotate components `: JSX.Element` / `: React.JSX.Element` without importing React — just let the return type infer.

---

## Native modules & the ABI split (important)

- **Electron 42 = Node 24 ABI 146**; system node is 22. A module built for one ABI **will not load** in the other.
- Workflow: `npm install` (builds for node ABI) → **`electron-rebuild -f -w better-sqlite3,node-pty`** (rebuilds for ABI 146). Both then load in the Electron main process. Confirmed via `scripts/smoke-native.cjs` (`npm run smoke:native`).
- Consequence for spikes/tests: anything needing native modules runs under **`electron`**; pure `child_process`/`fs` work runs under system **`node`**. (That's why `spike-capture`/`spike-extract` avoid native modules.)
- Packaging: `electron-builder.yml` sets `asarUnpack: "**/*.node"` so addons can be `dlopen`'d from a packaged app. (Loading under a **signed/hardened** build still to be validated when `sqlite-vec` lands in M3.)

Smoke output:
```
{ electron: "42.5.0", node: "24.17.0", modules_abi: "146",
  sqlite_version: "3.53.2", fts5: "ok (2 matches …)", pty: "ok" }
```

---

## Spike 1 — PTY ⇄ xterm.js running claude  ✅ confirmed live

- **Architecture:** `PtyManager` in main keyed by `tabId` ⇄ IPC ⇄ `@xterm/xterm` in the renderer. `contextIsolation: true`, `sandbox: false`, `nodeIntegration: false`; renderer touches only `window.zede` via `contextBridge`. Files: `src/main/pty/manager.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/terminal/Terminal.tsx`.
- **Spawn the login shell** (`$SHELL -l`, default `/bin/zsh -l`) so the user's profile is sourced and `claude` resolves on PATH (GUI-launched Electron otherwise has a minimal PATH). The manager then auto-types `claude --session-id <uuid>\r`.
- **End-to-end proof** (process ancestry): `Electron main (48190) → /bin/zsh -l (48209) → claude (48493)`. The renderer's xterm drove a real PTY that launched interactive claude.
- **No `React.StrictMode`** — its double-invoked effects would spawn+kill the PTY twice on mount. Revisit with a mount guard when the tab model lands (M2).
- Renderer bundle with xterm ≈ 970 kB (fine; lazy-load/tree-shake later).

---

## Spike 2 — transcript capture + session-id binding  ✅ confirmed

- **Path:** `~/.claude/projects/<encodeCwd(cwd)>/<sessionId>.jsonl`.
- **encodeCwd** = `cwd.replace(/[^A-Za-z0-9]/g, '-')`. Verified: e.g. `/Users/you/dev/clean` → `-Users-you-dev-clean`. Consistent with observed `frontendmasters.in → frontendmasters-in` (dots also → `-`). **Lossy / non-invertible — only ever forward-compute it.**
- **Binding strategy (robust):** spawn with **`--session-id <uuid>`** (we own the spawn) → path is known immediately. Because `<uuid>.jsonl` is globally unique, an **encoding-independent fallback** is `find ~/.claude/projects -name <uuid>.jsonl`. So we never depend on perfectly replicating the encoding.
- **`claude --resume <uuid>` appends to the same file in place** (16699 → 20839 bytes) — incremental tailing survives resumes.
- **Incremental watermark (validated):** read `[offset..EOF]`; parse only **complete** lines (defer a trailing partial line); advance offset past the last `\n`. **Truncation guard:** if `size < offset`, reset. Reading from the saved offset after a resume returned exactly the 7 new records (3 conversation).
- **Record model:** types seen — `user, assistant, attachment, last-prompt, mode, permission-mode, queue-operation, file-history-snapshot, ai-title, system`. Keep `type ∈ {user,assistant}`; drop `isMeta` (injected context) and `isSidechain` (subagent spans). Assistant `message.content` is an array of blocks incl. `thinking` — **extract from `text` blocks only.**
- Interactive claude writes its transcript **lazily on the first user turn**, not at startup — capture should expect the file to appear after the first message.

---

## Spike 3 — `claude -p` structured extraction  ✅ confirmed

**Command shape (works):**
```
claude -p "<span>" \
  --output-format json \
  --json-schema '<INLINE JSON SCHEMA>' \
  --append-system-prompt "<JSON-only extractor rules>" \
  --model claude-haiku-4-5-20251001   # cheap/fast for extraction
  [--session-id <uuid>]
```

- **`--json-schema` takes INLINE JSON**, not a file path (a path errors: *"--json-schema is not valid JSON"*). Root must be an **object** — wrap the array as `{ "memories": [ … ] }`.
- **Envelope** (`--output-format json`) is one object; keys include:
  `type, subtype, is_error, result, structured_output, session_id, usage, modelUsage, total_cost_usd, duration_ms, duration_api_ms, ttft_ms, num_turns, stop_reason, permission_denials, uuid`.
  - Model output is in **`result` as a JSON *string*** → `JSON.parse(envelope.result).memories`.
  - There's also a **`structured_output`** field (pre-parsed) — prefer it to skip the double-parse (confirm exact shape in M1).
  - `stop_reason: "tool_use"` — structured output is a forced tool call under the hood.
- **Quality:** from a 6-line span it returned 5 clean candidates with correct `type` enums + `scope_hint` + `confidence` (preferences, a decision, an entity). The schema kills the "garbage JSON poisons the store" failure mode (spec §11).
- **Cost / latency (the catch):** cold call ≈ **25 s wall** (ttft ≈ 16 s), **$0.33**, with large `cache_creation` (~24.5k tokens). The Haiku calls in Spike 2 ran in **~3 s**.
  - **M1 implications:** default the extractor to a **cheap/fast model** (`--model claude-haiku-…`), **debounce + batch** spans (≥5 s idle), **cap 1–2 concurrent**, and treat cost as a first-class budget. Ollama/heuristic tiers (spec §6.2) become attractive for cost/offline.

---

## FTS5 (spec §5 / task 6)  ✅

better-sqlite3 bundles SQLite **3.53.2 with FTS5**. `CREATE VIRTUAL TABLE … USING fts5(…)` + `MATCH` verified in the Electron smoke test. No extension needed for lexical search; `sqlite-vec` (semantic) is the only loadable-extension risk, deferred to M3.

---

## Carry-forward into M1

1. **Binding:** spawn `claude --session-id <uuid>`; record it on the `sessions` row; resolve transcript via forward-encode, fall back to `<uuid>.jsonl` glob.
2. **Capture:** byte-offset watermark per session; parse complete JSONL lines; filter to `user|assistant`, drop `isMeta`/`isSidechain`, keep `text` content blocks; truncation guard.
3. **Extractor:** `claude -p --output-format json --json-schema '<inline {memories:[…]}>' --append-system-prompt <rules> --model <cheap>`; parse `structured_output` (or `JSON.parse(result)`); debounce/batch/cap; strict-parse + drop-on-fail.
4. **Redaction** runs before the span reaches `claude -p` **and** before persisting candidates (spec §6.3).
5. **Native/Core** work stays in main; rebuild via `@electron/rebuild`; keep a single DB writer.

## Open follow-ups / risks
- **`sqlite-vec` under packaged + code-signed Electron** (hardened runtime) — validate in M3, not just dev.
- **`structured_output` field shape** — confirm and prefer over double-parsing `result` (M1).
- **Path encoding for exotic chars** (space, `_`, unicode, collisions) — mooted by uuid-glob binding; only matters if we ever need reverse mapping.
- **Extraction cost** — design the debounce/batch/model-tier budget deliberately in M1.
