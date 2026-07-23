# Zede — Development Plan

> Companion to [`zede-spec-2.md`](./zede-spec-2.md). The spec says **what** Zede is; this plan says **how and in what order** we build it. Section references like “(§7)” point back to the spec.

**Status:** greenfield (only the spec exists, no git repo yet).
**Stack decision:** **Electron + Node/TypeScript across the whole stack** (chosen over the spec’s Tauri/Rust recommendation — see §1).
**Target platform:** macOS-first (dev machine), keep cross-platform doors open.
**Horizon:** task-level detail for M0–M2 (the near term), lighter roadmap for M3–M4.

---

## 0. Verified facts (de-risking already done)

These were confirmed empirically against this machine (`claude` v2.1.187, macOS) before writing the plan, so the plan rests on facts, not assumptions:

| Question (spec open decision) | Finding | Consequence |
|---|---|---|
| **Transcript location/format** (§14.2) | `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. JSONL, one record/line, each with a `type`. Conversation records are `type: "user" \| "assistant"` carrying `message{role,content}` plus `uuid`, `parentUuid` (thread DAG), `timestamp`, `cwd`, `gitBranch`, `isSidechain`, `isMeta`, and (assistant) `usage` token counts. | Incremental byte-offset watermarking + span extraction is straightforward. Filter to user/assistant, drop `isMeta`, skip `isSidechain` (subagent noise) for v1. |
| **Deterministic tab↔transcript binding** (§14.2) | `claude --session-id <uuid>` **exists**. | Zede generates the UUID, spawns with it, and computes the transcript path immediately. No fragile “newest file after spawn” heuristic on the happy path (keep it only as a fallback for externally-launched sessions). |
| **Structured extraction reliability** (§6.2, §11) | `claude -p --output-format json` **and** `--json-schema <schema>` **exist**. | The extractor emits **schema-valid** JSON, killing the “garbage JSON poisons the store” failure mode at the source. Still strict-parse + drop-on-fail as belt-and-suspenders. |
| **Injection seam** (§6.5, §14.1) | `--append-system-prompt-file <path>` **exists**, and Zede owns the spawn. | Adapter B (flag/file) is a single spawn flag — reliable. Adapter A (`.zede/context.md` referenced from the project memory file) remains the transparent default. We get **both** essentially for free. |
| **cwd → dir encoding** | Both `/` and `.` map to `-` (`frontendmasters.in` → `frontendmasters-in`). Lossy / non-invertible. | Always **forward-compute** the dir from the known cwd; never try to invert an encoded dir back to a path. Confirm the full rule (spaces, `_`, unicode, collisions) in M0. |
| **Toolchain present** | Node 22, npm, pnpm; `claude` on PATH. **No Rust, no Ollama.** | Electron/Node path needs no new language. `claude -p` extraction works today. Ollama tier (§6.2.2) is a clean later add. |

**Architectural windfall:** because Zede launches `claude` itself, the two seams the spec flagged as riskiest — **binding** and **injection** — collapse into two CLI flags (`--session-id`, `--append-system-prompt-file`). Build around owning the spawn.

---

## 1. Stack (locked)

Whole stack in TypeScript so existing frontend skills carry top-to-bottom; the spec explicitly allows this (“Electron is the heavier alternative”, §12).

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Electron** | `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer + `contextBridge` preload. |
| Scaffold/build | **electron-vite** (React + TS template) | Fast HMR renderer, clean main/preload/renderer split. Package with **electron-builder**. |
| UI | **React + TypeScript** | Swap to Svelte is fine; not load-bearing. |
| Terminal | **xterm.js** (`@xterm/xterm` + `addon-fit` + `addon-webgl`) | Renderer-side; PTY I/O proxied over IPC. |
| PTY | **node-pty** | Native module → needs `@electron/rebuild`. |
| DB | **better-sqlite3** (FTS5 built in) | Synchronous, sub-ms; native module → rebuild. WAL mode. |
| Vector tier | **sqlite-vec** (`vec0`, loadable extension) | Phase 2 only; de-risk extension loading under packaged/signed Electron then. |
| Embeddings | **transformers.js** (`all-MiniLM-L6-v2`, 384-dim) in a worker | Matches spec’s `FLOAT[384]`. Zero external dep (resolves §14.4 toward bundling). Ollama as optional swap. |
| Extraction | spawn **`claude -p --output-format json --json-schema …`** | Default tier. Ollama / heuristic behind the same `Extractor` interface (§6.2). |

**Cost of this choice we accept:** larger binary (~120–180 MB) and higher RAM than Tauri. Fine for a personal/dev tool. Mitigations: `addon-webgl` for terminal perf, run CPU-bound work (embeddings) off the main process.

---

## 2. Process & module architecture (Electron mapping of spec §4)

Three logical layers, mapped onto Electron processes:

```
┌─────────────────────────────────────────────────────────────┐
│ RENDERER (Chromium, React)                                   │
│  Spaces sidebar · tab bar · xterm.js panes · memory panel    │
│  No Node, no DB. Talks only via window.zede (contextBridge). │
└───────────────▲───────────────────────────┬─────────────────┘
                │ IPC (typed)                │ IPC events
┌───────────────┴───────────────────────────▼─────────────────┐
│ MAIN process  = "Core" (Node)                                │
│  • PTY manager (node-pty)        • SQLite (better-sqlite3)    │
│  • Transcript watcher+watermark  • Pipeline orchestrator     │
│  • Retriever/ranker              • IPC router                 │
│  SINGLE WRITER to the DB.                                     │
└───────────────┬──────────────────────────────────────────────┘
                │ spawn / worker
        ┌───────▼────────┐        ┌────────────────────┐
        │ Extractor       │       │ Embedding worker    │
        │ child: claude -p│       │ (utilityProcess /   │
        │ (1–2 concurrent)│       │  worker_threads)    │
        └─────────────────┘       └────────────────────┘
```

Rules:
- **Single DB writer.** Only Core writes. Renderer never touches SQLite — everything via IPC. The embedding worker *returns vectors* to Core; Core writes them. WAL lets the UI’s reads run while Core writes (§10).
- **Phase 0/1:** Core lives in the **main process** (fast to build; better-sqlite3 is sync sub-ms; `claude -p` is an async child process, non-blocking).
- **Phase 2:** move embeddings (CPU-bound) into a **`utilityProcess`/worker**; keep all writes funneled through Core. Refactor extractor to its own pool if needed.
- **Security:** validate every IPC payload at the Core boundary; no raw paths/SQL from renderer.

### IPC contract (sketch — define as typed module shared by preload + Core)
```
pty.spawn({tabId, cwd, kind}) → {sessionId}   // kind: 'claude'|'shell'
pty.write({tabId, data}) ; pty.resize({tabId, cols, rows}) ; pty.kill({tabId})
event pty.data {tabId, chunk}  ;  event pty.exit {tabId, code}

space.list/create/update/delete/reorder
tab.list/create/update/close/pin/reorder
memory.list({spaceId, type?}) / search({q, semantic?}) / get(id)
memory.delete({id, hard?}) / pin / unpin / edit / rescope
memory.forgetAbout({query, scope})        // semantic batch delete (Phase 2)
event memory.learned {memory}             // "Just learned…" stream
event memory.forgotten {id, fingerprint}  // undo toast / Recently forgotten
```

---

## 3. Repository layout

```
zede/
├─ package.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ src/
│  ├─ main/                  # Core (Node) — the whole spec §4.2 pipeline
│  │  ├─ index.ts            # app lifecycle, window, IPC wiring
│  │  ├─ pty/               # node-pty manager
│  │  ├─ db/                # better-sqlite3, migrations, queries
│  │  │  └─ migrations/     # 0001_init.sql, 0002_*.sql … (user_version)
│  │  ├─ capture/           # watcher + watermark + jsonl span parser
│  │  ├─ extract/           # Extractor interface + ClaudeCode/Ollama/Heuristic
│  │  ├─ pipeline/          # redact → dedup/merge → conflict/supersede → store
│  │  ├─ retrieve/          # ranker + token-budget fill
│  │  ├─ inject/            # ContextAdapter A (file) + B (flag)
│  │  └─ forget/            # tombstones, cascade, audit, undo window
│  ├─ preload/index.ts      # contextBridge → window.zede
│  ├─ renderer/             # React UI
│  │  ├─ spaces/ tabs/ terminal/ memory/   # feature folders
│  └─ shared/               # IPC types, domain types, constants
├─ test/
│  ├─ fixtures/transcripts/ # sanitized .jsonl corpora for the pipeline
│  └─ …
└─ DEVELOPMENT_PLAN.md / zede-spec-2.md
```

---

## 4. Data model & migrations

- Use the spec §5 schema as the target. Drive migrations off `PRAGMA user_version`; one ordered `.sql` file per version, applied in a transaction at startup.
- **v1 subset** (M1): `spaces`, `tabs`, `sessions`, `transcript_watermarks`, `memories`, `memory_sources`, `tombstones`, `audit_log`, `memories_fts`. Defer `memory_links`, `memory_edits`, `redactions` (config-in-code first), `memories_vec`.
- **Append-only invariant** (§11): `tombstones` and `audit_log` are **never** destructively migrated. Migrations may add columns/tables around them but must not drop/rewrite their rows.
- WAL mode on; `0600` perms on the DB file (§9); store under Electron `app.getPath('userData')/zede.db`.
- On launch: integrity check; rebuild `memories_fts` from `memories` if corrupt (§10).

---

## 5. The pipeline, made concrete (spec §6 in commands)

| Stage | Concrete implementation |
|---|---|
| **Spawn** | `claude --session-id <uuid>` via node-pty in the tab’s cwd. Record `cc_session_id=<uuid>`, `transcript_path = ~/.claude/projects/<encode(cwd)>/<uuid>.jsonl` on the `sessions` row. |
| **Capture** (§6.1) | chokidar watch on that file. Maintain **byte-offset** `last_offset`. On change: read `[offset..EOF]`, split on `\n`, process only **complete** lines (last partial line waits), advance offset past the last complete line. Handle truncation: if `size < last_offset`, reset/re-baseline. Parse → keep `type∈{user,assistant}`, drop `isMeta`, skip `isSidechain`; pull text content blocks into spans. |
| **Extract** (§6.2) | Debounce **5 s** after last activity; cap **1–2** concurrent. `claude -p --output-format json --json-schema <candidate[]> --append-system-prompt "<JSON-only extractor rules>"` with spans as the prompt. Parse the JSON envelope’s `result` (schema-guaranteed). Strict-parse; drop+log+retry-next-flush on failure (§11). |
| **Redact** (§6.3) | Run the redaction regex/entropy set **twice**: (a) on spans **before** they reach `claude -p` (don’t re-transmit pasted secrets), and (b) on candidate `content` **before** persist. Patterns: `sk-…`, AWS keys, `-----BEGIN … KEY-----`, JWTs, `password=`, high-entropy tokens. Drop or mask. |
| **Dedup / forget-check** (§6.3, §7) | Compute fingerprint (normalized-text hash in v1; semantic in Phase 2). **If it matches a `tombstones.fingerprint` → drop** (the headline mechanic). Else if it matches an active memory → bump `use_count`/`salience`. Else insert `status='active'`. |
| **Conflict/supersede** (§6.3) | Phase 2: contradicting preference → insert new `active`, mark old `superseded`, link `supersedes`. Never silent overwrite. |
| **Retrieve** (§6.4) | Per active Space at session start. Score = pin + bm25(FTS5) + recency + freq + scope − staleness (semantic cosine added in Phase 2). Greedy-fill a **~1–2k-token** budget; pinned forced first up to a pin sub-budget. Seed “query” from **cwd + Space + recent tab titles**. Target **<50 ms p95**; cache active set per Space. |
| **Inject** (§6.5) | **Adapter A (default):** write selected set to gitignored `.zede/context.md`, reference it from the project memory file. **Adapter B:** add `--append-system-prompt-file .zede/context.md` to the spawn. Behind a `ContextAdapter` interface so the seam can shift. |

---

## 6. Milestones

Estimates are indicative for one developer; treat as relative sizing, not commitments.

### M0 — Foundation & de-risking spikes  ·  ~3–5 days
> ✅ **Done (2026-06-24)** — full results in [`docs/spikes.md`](./docs/spikes.md). All three seams proven live; scaffold builds + typechecks; native modules load under Electron's ABI.

**Goal:** retire the Electron-specific native-module risks and prove the three live seams in *this* runtime before building product surface.

- [ ] `git init`; scaffold with **electron-vite** (React+TS); strict `tsconfig`; ESLint/Prettier; commit the spec + this plan.
- [ ] **Native modules:** install `node-pty` + `better-sqlite3`; wire `@electron/rebuild`; confirm both load in a packaged smoke build (configure `asarUnpack` for `.node`).
- [ ] **Spike 1 (PTY):** xterm.js pane runs an interactive `claude` in a chosen cwd; bidirectional I/O + resize via IPC.
- [ ] **Spike 2 (capture/bind):** spawn `claude --session-id <uuid>`; compute + confirm the transcript path; tail it with byte-offset watermark; log parsed new records. **Confirm the exact cwd→dir encoding rule** (test paths with `.`, `_`, space, unicode; note collision risk).
- [ ] **Spike 3 (extract):** feed a fixture span to `claude -p --output-format json --json-schema …`; confirm the JSON envelope shape and schema-valid `result`; measure latency.
- [ ] **Verify** FTS5 is present in better-sqlite3 (`CREATE VIRTUAL TABLE … fts5`).
- [ ] Write findings to `docs/spikes.md` (envelope shape, encoding rule, latencies).

**Exit:** all three spikes green; native modules survive a packaged build; encoding rule documented.

---

### M1 — Phase 0 demo slice (spec §13.0)  ·  ~4–7 days
> ✅ **Done (2026-06-24)** — full vertical slice built + verified headlessly (`ZEDE_SELFTEST=1 electron .`, 20/20 PASS = 19 offline + 1 live, incl. tombstone-suppression). Capture→extract→redact→store→sidebar runs in the app.

**Goal:** the smallest thing that *feels* like the product — and it already forgets correctly.

- [ ] DB layer: migration runner + **v1 schema subset** (§4 above); WAL; `0600`.
- [ ] One window, one **hard-coded** Space, one xterm.js tab running `claude --session-id`.
- [ ] **Capture → extract** wired end-to-end (watcher → debounced span batch → `claude -p` extractor).
- [ ] **Redaction pass** (regex+entropy) before persist — non-optional even in the demo (§6.3).
- [ ] **Naive dedup** (exact fingerprint) → insert into `memories` + `memory_sources`.
- [ ] **Memory sidebar:** list memories grouped by `type`; live “Just learned…” updates via `memory.learned` event.
- [ ] Per-memory **✕ = soft delete**: `status='tombstoned'` + write `tombstones.fingerprint` + `audit_log` row.
- [ ] **Tombstone suppression** in dedup — deletion **sticks across the next extraction pass** (the soul of the product, included from day one even though ranking/injection aren’t).

**Exit:** run `claude`, do real work, watch memories appear; delete one; keep working; **it does not silently reappear.** No ranking/injection yet.

---

### M2 — Phase 1: spatial model + closed loop (spec §13.1)  ·  ~2–3 weeks
> ✅ **Done (2026-06-24)** — Spaces rail + multi-tab (pin, claude/shell), per-Space scoping, FTS5+recency+freq+pin+scope ranker (5 ms / 2 k memories), injection Adapter A (`.zede/context.md` + `CLAUDE.md` `@import`) & B (`--append-system-prompt-file`), hard-delete-keeps-fingerprint, undo toast, session scrollback restore. Memory panel collapsible + **⌘M**. Headless self-test 34/34.

**Goal:** real Spaces/tabs/pins, per-Space scoping, and the loop **closed** (sessions consume memories at start). This is the first build that is genuinely *Zede*.

- [ ] **Spaces sidebar** (Arc-style): create/rename/icon/reorder/delete; switching swaps the whole tab set **and** the active memory scope; persists across restart.
- [ ] **Tabs:** multiple per Space; pin affordance; pinned sort above ephemeral and survive “clear”; per-tab `cwd`/`title`; `kind ∈ {claude, shell}`.
- [ ] **Per-Space scoping:** `space_id` on memories + `scope='global'`; retrieval respects scope.
- [ ] **Retriever + ranker** (FTS5 + recency + freq + pin + scope; no embeddings yet) with token-budget greedy fill + pin sub-budget; active-set cache per Space; assert **<50 ms p95**.
- [ ] **Injection Adapter A** (`.zede/context.md` + project-memory reference) behind `ContextAdapter`; verify a fresh session in a Space sees that Space’s memories. Keep **Adapter B** (`--append-system-prompt-file`) wired as the fallback toggle.
- [ ] **Soft + hard delete** complete: hard purges row + `memory_sources` + excerpts but **keeps the fingerprint** (§7); cascade (unlink merges, re-eval supersede); **undo window + toast**.
- [ ] **Redaction hardened** + unit-tested against a planted-secrets corpus.
- [ ] **Session persistence:** on quit serialize scrollback + cwd to `pty_snapshot_ref`; restore visual state on launch (state/history, not live PIDs — §8).
- [ ] **Audit log** surfaced; `.zede/` gitignored by default (§9).

**Exit:** open a new `claude` session in Space A → it’s injected with A’s memories, **not** Space B’s; deletes stick; restart restores Spaces/tabs/scrollback.

---

### M3 — Phase 2: semantic + intelligence (spec §13.2)  ·  ~2–4 weeks
> ✅ **Done (2026-06-24)** — `Embedder` interface with a zero-dep **hashing floor** (default, tested offline) + lazy **transformers.js MiniLM** tier; async embedding queue → `memory_embeddings` with **brute-force cosine** (sqlite-vec intentionally deferred — see note); cosine term in the ranker + semantic `search`/`forget-about`; **supersede** via `memory_links`; **salience decay + auto-archive** (archive ≠ forget — archived re-derives, tombstoned never does); **Heuristic** + **Ollama** extractor tiers; encryption **key** via `safeStorage`. Self-test 41/41.
>
> _Deferred-by-choice:_ `sqlite-vec` (brute-force cosine is ample at personal scale and dodges the signed-build extension-loading risk until M4 packaging); moving the MiniLM embedder into a `utilityProcess` (the hashing default is trivial CPU); full SQLCipher at-rest encryption needs the `better-sqlite3-multiple-ciphers` build (the key plumbing is in place).

- [ ] **Embeddings** (transformers.js MiniLM-384) async in a worker; populate `memories_vec`. **De-risk `sqlite-vec` loading under packaged + code-signed Electron here** (hardened-runtime/extension-loading gotcha).
- [ ] **Semantic search** toggle in the panel; add cosine term to the ranker; second retrieval pass once the user types a real prompt (§6.4).
- [ ] **Supersede/conflict** handling (§6.3) with `memory_links`.
- [ ] **Salience decay** + auto-archive (not delete) below a floor (§11).
- [ ] **“Forget about X”** semantic batch delete: embed → threshold-select in scope → **preview → confirm** → tombstone family (§7).
- [ ] **Ollama tier** (extraction + embeddings) behind the existing interfaces; **Heuristic tier** as the zero-dep floor (§6.2).
- [ ] **Optional encryption at rest:** better-sqlite3-multiple-ciphers / SQLCipher, key via OS keychain (`safeStorage`/keytar); off by default (§9).

---

### M4 — Phase 3: polish & release (spec §13.3)  ·  ~1–2 weeks + ongoing
> ✅ **Done (2026-06-24)** — inline **edit + before→after diff** (`memory_edits`), **Recently-forgotten** view with restore, undo toast, **multi-Space membership** (share to Space), **Export** JSON/Markdown via save dialog, **Settings** (egress-posture display, extraction-tier picker, semantic/encryption/pinned-tab toggles, injection-adapter picker), and **packaging** (electron-builder mac dmg/zip + hardened-runtime entitlements + guarded notarize hook; see [`docs/packaging.md`](./docs/packaging.md)). Self-test 46/46. _Signing/notarization need an Apple Developer cert (documented, not run here); auto-update + `sqlite-vec`-under-signed-build remain._

- [ ] Undo toasts everywhere; memory **diff/edit** view (`memory_edits`); **“Recently forgotten”** view sourced from tombstones (§7).
- [ ] **Export** (JSON/Markdown); **multi-Space membership** table (§11).
- [ ] **Settings:** explicit **egress posture** display (§9), extraction-tier picker, encryption toggle, pinned-tab⇒pinned-memory toggle (§14.5).
- [ ] **Packaging:** macOS sign + notarize; perf passes (retrieval p95, idle `VACUUM`/FTS optimize, launch integrity check); optional auto-update.

---

## 7. Critical path & sequencing

```
M0 native-modules+spikes ─▶ M1 capture→extract→store→tombstone ─▶ M2 spaces+scope+retrieve+inject ─▶ M3 semantic ─▶ M4 polish
                                     │                                   │
   tombstone-suppression  ──────────┘ (built in M1, the headline)       └─ injection closes the loop (first true "Zede")
```

- **Hard gate:** M0 native-module rebuild + the three spikes. Everything downstream assumes node-pty, better-sqlite3, and `claude -p` work *inside Electron*. Don’t start product UI until these are green.
- **Build the headline early:** tombstone-prevents-re-derivation lands in **M1**, not M2 — it’s the product’s identity and cheap to include once dedup exists.
- **First “real product” = end of M2** (loop closed). Target ~**4–6 weeks** to that point, solo.
- **sqlite-vec** is the one deferred technical risk; isolate it to M3 and validate under a *signed* build, not just dev.

---

## 8. Testing strategy

- **Unit (pure functions — highest ROI):** redaction (planted-secret corpus), fingerprint/normalization, dedup + **tombstone suppression**, ranker scoring + token-budget fill, JSONL span parser (partial-line/offset edge cases), cwd→dir encoder.
- **Integration:** `fixtures/transcripts/*.jsonl` → watcher → extractor (with a **mock** `claude -p` returning canned JSON so tests are offline/deterministic) → DB; assert memories + that a tombstoned item never re-inserts.
- **E2E:** Playwright-for-Electron — spawn a tab, drive the memory panel, delete → assert gone and stays gone after more activity; Space switch swaps scope.
- **Perf:** seed N=10k memories; assert retrieval **<50 ms p95** (§10).
- **Migration:** apply 0→latest on a fixture DB; assert tombstones/audit survive every step (§4 invariant).

---

## 9. Cross-cutting engineering standards

- TypeScript **strict**; shared domain + IPC types in `src/shared`.
- **Single DB writer** (Core only); renderer is DB-blind.
- **Redact-before-anything** — pre-extraction *and* pre-persist (§5).
- Migrations append-only for `tombstones`/`audit_log` (§11).
- Electron security: `contextIsolation`, no `nodeIntegration`, sandboxed renderer, validate IPC inputs, no remote content.
- **Egress honesty (§9):** the app makes no network calls itself; the only egress is the chosen extraction tier (`claude -p` reuses existing Claude Code auth; Ollama/Heuristic = none). State this in Settings.
- Every deletion → `audit_log` + undo toast; nothing vanishes without a trace (§7).

---

## 10. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Native-module ABI pain (node-pty, better-sqlite3) under Electron + packaging | Med | `@electron/rebuild` + `asarUnpack`; validate in a **packaged** smoke build in M0, not just dev. |
| `sqlite-vec` extension loading blocked by macOS hardened runtime / signing | Med | Isolate to M3; test under a signed build; fallback = FTS5-only ranking (semantic is an *optional* tier per §5). |
| `claude -p` JSON envelope/flags shift across CLI versions | Low–Med | `--json-schema` + strict-parse + drop-on-fail (§11); pin the observed envelope shape in `docs/spikes.md`; keep Heuristic tier as a floor. |
| Transcript format/encoding changes in a future Claude Code release | Low | Capture layer is small + adapter-shaped; fixtures catch regressions; binding via `--session-id` (we own the spawn) is more stable than path-sniffing. |
| Main-process jank from CPU-bound embeddings | Med (Phase 2) | Move embeddings to `utilityProcess`/worker; keep writes single-threaded in Core. |
| Secret leaks into memories | High impact | Redaction is non-optional and tested first (M1/M2); applied pre-extraction too. |
| Electron footprint (RAM/binary) | Accepted | Known trade of the stack choice; `addon-webgl`, lazy-load panels, off-main heavy work. |

---

## 11. Resolved open decisions (spec §14)

| # | Decision | Resolution for v1 |
|---|---|---|
| 1 | Injection seam (file vs flag) | **Default Adapter A** (`.zede/context.md`, inspectable). Adapter B (`--append-system-prompt-file`) wired as fallback toggle — trivial since we own the spawn. |
| 2 | Transcript discovery/binding | **Solved:** `--session-id <uuid>` + forward-computed path. Newest-file heuristic only for externally-launched sessions. |
| 3 | Default scope | **Per-Space** (Spaces ≈ projects). `global` for cross-Space facts; defer a `space_membership` table to M4. |
| 4 | Embedding model | **Bundle** transformers.js MiniLM-384 (zero external dep). Ollama as optional swap. |
| 5 | Pinned-tab ⇒ pinned-memory | **Explicit per-tab toggle**, default **off**, in M4 settings — avoid surprising auto-pins. |
| — | Extraction tier default | **`claude -p`** (installed, best quality, reuses auth). Ollama for hard-offline; Heuristic as floor. |
| — | Offline hardness | `claude -p` (networked via Claude Code, which you already run) is the default; flip the default to Ollama only if you later declare a hard no-network requirement. |

> Two of these (1, 2) are no longer real risks because Zede controls the `claude` spawn. If you *do* want a hard-offline default (#4/tier), say so and M3’s Ollama work moves earlier.

---

## 12. Immediate next actions (first ~2 days)

1. `git init` + initial commit (spec + this plan).
2. Scaffold **electron-vite** (React+TS); add ESLint/Prettier/strict TS.
3. Install + `@electron/rebuild` **node-pty** and **better-sqlite3**; prove they load in a packaged smoke build.
4. **Spike 1** (xterm.js ⇄ `claude` PTY) and **Spike 2** (`--session-id` spawn → tail transcript with watermark) — the two that unblock everything.
5. Record encoding rule + `claude -p` envelope shape in `docs/spikes.md`.

> When you’re ready to start building, say the word and I’ll begin at action #1 (or jump straight to a specific spike).
