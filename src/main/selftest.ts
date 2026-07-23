import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { openDatabase } from './db/database'
import { MemoryRepo } from './db/memories'
import { MemoryStore } from './pipeline/store'
import { ClaudeCodeExtractor } from './extract/claude'
import { Retriever } from './retrieve/ranker'
import { ContextWriter } from './inject/context'
import { Core } from './core'
import { HashingEmbedder, cosine } from './embed/embedder'
import { HeuristicExtractor } from './extract/heuristic'
import { fingerprint } from './pipeline/fingerprint'
import { redact } from './pipeline/redact'
import { recordsToSpan, recordsToSpans, readFrom, userPrompts } from './capture/parser'
import { CaptureService } from './capture/watcher'
import { ConversationStore } from './conversations/store'
import { FORMAT_VERSION, exportTree, parseMemoryFile, serializeMemory, type SyncedMemory } from './sync/format'
import { SyncCipher, deriveKey, makeCheck, newSalt, verifyCheck } from './sync/crypto'
import { importTree } from './sync/merge'
import { SyncService } from './sync/service'
import { gitAvailable, run } from './sync/git'
import type { Candidate } from './extract/types'

// Headless verification of the M1 forget loop. Run: ZEDE_SELFTEST=1 electron .
// (ZEDE_SELFTEST_LIVE=1 also proves the real claude -p extractor.)
export async function runSelfTest(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'zede-selftest-'))
  const db = openDatabase(join(dir, 'test.db'))
  const repo = new MemoryRepo(db)
  const now = Date.now()
  repo.ensureSpace('default', 'Default', now)
  repo.ensureTab('main', 'default', 'claude', 'claude', process.cwd(), now)
  repo.insertSession({ id: 's1', tabId: 'main', ccSessionId: 's1', transcriptPath: '/tmp/x.jsonl', startedAt: now, status: 'live' })

  const forgotten: string[] = []
  const store = new MemoryStore(repo, () => {}, (id) => forgotten.push(id))

  const cands: Candidate[] = [
    { type: 'preference', content: 'Always use pnpm, never npm.', confidence: 0.95, scope_hint: 'space' },
    { type: 'decision', content: 'Switch internal calls from REST to gRPC.', confidence: 0.9, scope_hint: 'space' },
    { type: 'entity', content: 'The user name is Goldie.', confidence: 0.95, scope_hint: 'global' }
  ]
  const ctx = { spaceId: 'default', sessionId: 's1', transcriptPath: '/tmp/x.jsonl', spanStart: 0, spanEnd: 1, excerpt: '…' }

  let ok = true
  const check = (name: string, cond: boolean): void => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`)
    if (!cond) ok = false
  }

  // --- pure functions (redaction is security-critical) ---
  // Fixture keys are assembled from parts so secret scanners don't flag them as real.
  const fakeAnthropicKey = ['sk-ant', 'api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'].join('-')
  const fakeAwsKey = 'AKIA' + 'ABCDEFGHIJKLMNOP'
  const sec = redact(`key ${fakeAnthropicKey} and ${fakeAwsKey} here`)
  check(
    'redact masks anthropic + aws keys',
    sec.redactions >= 2 && !sec.text.includes(fakeAnthropicKey.slice(0, 12)) && !sec.text.includes(fakeAwsKey)
  )
  check('redact leaves clean text untouched', redact('we use pnpm and tabs').redactions === 0)
  check('fingerprint stable under case/punctuation', fingerprint('Use pnpm!') === fingerprint('use   pnpm'))
  const span = recordsToSpan([
    { type: 'user', message: { role: 'user', content: 'hello world' } },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'SIDE' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking' }, { type: 'text', text: 'reply' }] } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'META' } }
  ])
  check(
    'span keeps user+assistant text; drops sidechain/meta/thinking',
    span.includes('hello world') && span.includes('reply') && !span.includes('SIDE') && !span.includes('META')
  )

  const r1 = store.store(cands, ctx, Date.now())
  check('insert 3 fresh memories', r1.inserted.length === 3)
  check('listActive shows 3', repo.listActive('default').length === 3)

  const r2 = store.store(cands, ctx, Date.now())
  check('re-store dedups (0 new, 3 deduped)', r2.inserted.length === 0 && r2.deduped === 3)
  check('still 3 active after dedup', repo.listActive('default').length === 3)

  const target = repo.listActive('default').find((m) => m.content.includes('pnpm'))
  check('found pnpm memory to delete', !!target)
  const del = target ? store.softDelete(target.id, Date.now()) : false
  check('soft delete returns true', del)
  check('forgotten event fired', !!target && forgotten.includes(target.id))
  check('2 active after delete', repo.listActive('default').length === 2)
  check('tombstone fingerprint written', repo.isTombstoned(fingerprint('Always use pnpm, never npm.')))

  const r3 = store.store(cands, ctx, Date.now())
  check('re-store SUPPRESSES the deleted one (1 suppressed)', r3.suppressed === 1)
  check('deleted memory does NOT reappear', repo.listActive('default').length === 2)
  check('pnpm memory stays gone', !repo.listActive('default').some((m) => m.content.includes('pnpm')))

  // --- capture data-flow (offline; same sequence as CaptureService.flush) ---
  const tpath = join(dir, 'transcript.jsonl')
  writeFileSync(
    tpath,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'I prefer Helix and we deploy on Fridays.' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Got it.' }] } }),
      ''
    ].join('\n')
  )
  repo.insertSession({ id: 's2', tabId: 'main', ccSessionId: 's2', transcriptPath: tpath, startedAt: Date.now(), status: 'live' })
  const wm0 = repo.getWatermark('s2')
  const read = readFrom(tpath, wm0)
  const span2 = recordsToSpan(read.records)
  check('capture: span read from transcript', span2.includes('Helix') && read.newOffset > 0)
  const mockCands: Candidate[] = [{ type: 'preference', content: 'User prefers Helix.', confidence: 0.9, scope_hint: 'space' }]
  store.store(mockCands, { spaceId: 'default', sessionId: 's2', transcriptPath: tpath, spanStart: wm0, spanEnd: read.newOffset, excerpt: span2.slice(0, 200) }, Date.now())
  repo.setWatermark('s2', read.newOffset, Date.now())
  check('capture: watermark advanced', repo.getWatermark('s2') === read.newOffset)
  check('capture: nothing re-read past watermark', readFrom(tpath, repo.getWatermark('s2')).records.length === 0)

  // --- chunking: a large transcript splits into many spans, none truncated away
  //     (backfill correctness — recordsToSpan would have dropped everything past 12k) ---
  const big = Array.from({ length: 40 }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    message: { role: 'x', content: `marker${i} ` + 'x'.repeat(800) }
  }))
  const spans = recordsToSpans(big)
  check('chunk: long transcript splits into multiple spans', spans.length > 1)
  check('chunk: every span within the size cap', spans.every((s) => s.length <= 12000))
  check('chunk: keeps content single recordsToSpan would truncate', spans.join('\n').includes('marker0 ') && spans.join('\n').includes('marker39 '))

  // --- M2: per-Space scoping ---
  repo.createSpace({ id: 'spaceB', name: 'B', icon: null, sortOrder: 1, now: Date.now() })
  store.store([{ type: 'fact', content: 'Project B uses Deno.', confidence: 0.9, scope_hint: 'space' }], { ...ctx, spaceId: 'spaceB' }, Date.now())
  const bInDefault = repo.listActive('default').some((m) => m.content.includes('Deno'))
  const globalInB = repo.listActive('spaceB').some((m) => m.content.includes('Goldie'))
  check('scope: space-B memory hidden from default Space', !bInDefault)
  check('scope: global memory visible in every Space', globalInB)

  // --- M2: ranker (pin precedence + token budget + perf) ---
  const ranker = new Retriever(repo)
  const pinTarget = repo.listActive('default').find((m) => m.content.includes('gRPC'))
  if (pinTarget) repo.setPinned(pinTarget.id, true, Date.now())
  const ranked = ranker.rank({ spaceId: 'default', seed: 'gRPC REST internal', now: Date.now() })
  check('ranker: pinned memory ranks first', !!pinTarget && ranked[0]?.row.id === pinTarget.id)

  const bulk = repo.transaction(() => {
    for (let i = 0; i < 2000; i++)
      repo.insertMemory({
        id: `perf-${i}`,
        spaceId: 'default',
        scope: 'space',
        type: 'fact',
        content: `Perf fact ${i} concerning widget ${i % 50} and module ${i % 7}.`,
        confidence: 0.4,
        salience: 0.4,
        sourceHash: fingerprint(`perf-${i}`),
        now: Date.now()
      })
  })
  bulk()
  const t0 = performance.now()
  const sel = ranker.select({ spaceId: 'default', seed: 'widget 7 module 3 fact', now: Date.now() })
  const dt = performance.now() - t0
  check(`ranker: select <50ms over 2000 memories (${dt.toFixed(1)}ms)`, dt < 50)
  check('ranker: respects ~1.5k token budget', sel.tokens <= 1500)

  // --- M2: hard delete keeps the fingerprint (cannot be re-derived) ---
  const hd = store.store([{ type: 'decision', content: 'Adopt trunk-based development.', confidence: 0.9, scope_hint: 'space' }], ctx, Date.now())
  const hdId = hd.inserted[0]?.id
  const hardOk = !!hdId && store.hardDelete(hdId, Date.now())
  check('hard delete returns true', hardOk)
  check('hard delete purges the row', !!hdId && repo.getRow(hdId) === undefined)
  check('hard delete keeps the fingerprint tombstone', repo.isTombstoned(fingerprint('Adopt trunk-based development.')))
  const reHard = store.store([{ type: 'decision', content: 'Adopt trunk-based development.', confidence: 0.9, scope_hint: 'space' }], ctx, Date.now())
  check('hard-deleted fact does NOT re-derive', reHard.suppressed === 1)

  // --- M2: undo a soft delete ---
  const u = store.store([{ type: 'preference', content: 'Prefer 2-space indentation.', confidence: 0.9, scope_hint: 'space' }], ctx, Date.now())
  const uId = u.inserted[0]?.id as string
  store.softDelete(uId, Date.now())
  check('undo: gone after soft delete', repo.getRow(uId)?.status === 'tombstoned')
  const restored = store.undo(uId, Date.now())
  check('undo: restored to active', !!restored && repo.getRow(uId)?.status === 'active')
  check('undo: tombstone lifted', !repo.isTombstoned(fingerprint('Prefer 2-space indentation.')))

  // --- M2: injection artifact (Adapter A) ---
  const cwd = mkdtempSync(join(tmpdir(), 'zede-cwd-'))
  mkdirSync(join(cwd, '.git'))
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n')
  const writer = new ContextWriter()
  const inj = writer.write(cwd, repo.listActiveRows('default').slice(0, 5), 'Default', 'file')
  check('inject: .zede/context.md written', existsSync(inj.contextPath) && readFileSync(inj.contextPath, 'utf8').includes('Zede memory'))
  check('inject: .zede/ gitignored', readFileSync(join(cwd, '.gitignore'), 'utf8').includes('.zede/'))
  check('inject: CLAUDE.md references context', readFileSync(join(cwd, 'CLAUDE.md'), 'utf8').includes('@.zede/context.md'))

  // A project last touched under the old name carries a `loom:` block importing
  // `.loom/context.md`. We no longer write that file, so the block must be removed
  // (not merely superseded) or Claude Code keeps importing frozen memory.
  const legacyCwd = mkdtempSync(join(tmpdir(), 'zede-legacy-'))
  mkdirSync(join(legacyCwd, '.git'))
  writeFileSync(
    join(legacyCwd, 'CLAUDE.md'),
    '# House rules\n\nUse tabs.\n\n<!-- loom:begin (managed — do not edit) -->\n@.loom/context.md\n<!-- loom:end -->\n'
  )
  writer.write(legacyCwd, repo.listActiveRows('default').slice(0, 5), 'Default', 'file')
  const migrated = readFileSync(join(legacyCwd, 'CLAUDE.md'), 'utf8')
  check('inject: legacy loom block removed', !migrated.includes('loom:begin') && !migrated.includes('@.loom/context.md'))
  check('inject: legacy migration keeps user prose', migrated.includes('# House rules') && migrated.includes('Use tabs.'))
  check('inject: legacy migration adds zede import', migrated.includes('@.zede/context.md'))

  // --- M3: hashing embedder cosine ---
  const he = new HashingEmbedder()
  const va = await he.embed('the production database uses postgres and redis')
  const vb = await he.embed('postgres and redis power our production database')
  const vc = await he.embed('she painted the small wooden boat bright yellow')
  check('embed: related text scores higher cosine than unrelated', cosine(va, vb) > cosine(va, vc))

  // --- M3: heuristic extractor tier (offline floor) ---
  const hx = new HeuristicExtractor()
  const hc = await hx.extract(
    'I prefer Helix as my editor. We decided to switch to gRPC. TODO: write the onboarding docs. My name is Goldie.',
    { cwd: '/x', spaceId: 'default' }
  )
  const ht = new Set(hc.map((c) => c.type))
  check('heuristic: pulls preference+decision+todo+entity offline', ht.has('preference') && ht.has('decision') && ht.has('todo') && ht.has('entity'))

  // --- M3: supersede + semantic forget + decay/archive (via a real Core) ---
  const core = new Core(join(dir, 'core.db'), () => undefined)
  core.setSettings({ semanticEnabled: true })
  const cctx = { spaceId: 'default', sessionId: 'cs', transcriptPath: '/tmp/x.jsonl', spanStart: 0, spanEnd: 1, excerpt: '…' }
  core.store.store([{ type: 'preference', content: 'I prefer tabs for indentation.', confidence: 0.9, scope_hint: 'space' }], cctx, Date.now())
  await core.embed.drain()
  core.store.store([{ type: 'preference', content: 'I prefer spaces for indentation.', confidence: 0.9, scope_hint: 'space' }], cctx, Date.now())
  await core.embed.drain()
  const indent = core.repo.listActive('default').filter((m) => m.content.includes('indentation'))
  check('supersede: contradicting preference replaces the older (not duplicated)', indent.length === 1 && indent[0].content.includes('spaces'))

  const fa = await core.forgetAboutPreview('default', 'spaces for indentation')
  check('forget-about: semantic preview surfaces the family', fa.some((m) => m.content.includes('indentation')))

  const oldId = 'stale-1'
  const oldFp = fingerprint('Ephemeral fact nobody reused.')
  core.repo.insertMemory({
    id: oldId,
    spaceId: 'default',
    scope: 'space',
    type: 'fact',
    content: 'Ephemeral fact nobody reused.',
    confidence: 0.1,
    salience: 0.06,
    sourceHash: oldFp,
    now: Date.now() - 40 * 86_400_000
  })
  core.runMaintenance(Date.now())
  check('decay: stale low-salience memory auto-archived', core.repo.getRow(oldId)?.status === 'archived')
  check('decay: archived memory is NOT tombstoned', !core.repo.isTombstoned(oldFp))
  const reArch = core.store.store([{ type: 'fact', content: 'Ephemeral fact nobody reused.', confidence: 0.5, scope_hint: 'space' }], cctx, Date.now())
  check('decay: archived fact CAN re-derive (archive ≠ forget)', reArch.inserted.length === 1)

  // --- M4: edit history (diff) ---
  const editTarget = core.repo.listActive('default').find((m) => m.content.includes('indentation'))
  const beforeText = editTarget?.content
  const edited = editTarget ? core.editMemory(editTarget.id, 'I prefer four-space indentation everywhere.') : null
  check('edit: content updated', !!edited && edited.content.includes('four-space'))
  check('edit: history records the before→after diff', !!editTarget && core.history(editTarget.id).some((h) => h.before === beforeText))

  // --- M4: multi-Space membership ---
  const other = core.createSpace('Other')
  const shareTarget = core.repo.listActive('default').find((m) => m.scope === 'space')
  if (shareTarget) core.shareToSpace(shareTarget.id, other.id)
  check('membership: shared memory shows in the other Space', !!shareTarget && core.listMemories(other.id).some((m) => m.id === shareTarget.id))

  // --- saved conversations (per-tab JSON snapshots; load restores + resumes) ---
  const claudeDir = join(dir, 'fake-claude-projects')
  const conv = new ConversationStore(join(dir, 'conversations'), (_cwd, sid) => join(claudeDir, `${sid}.jsonl`))
  const ctPath = join(dir, 'conv-transcript.jsonl')
  writeFileSync(
    ctPath,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'How do I fix the flaky clock test?' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Pin the clock.' }] } }),
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'META' } }),
      ''
    ].join('\n')
  )
  // Session ids are UUIDs in real use; the store rejects anything else (they feed shell strings + paths).
  const saved = conv.save({ title: 'flaky test', sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/tmp/projA', transcriptPath: ctPath })
  check('conversation: save counts real turns only (meta dropped)', saved.messageCount === 2)
  check('conversation: preview comes from the first user turn', saved.preview.includes('flaky clock test'))
  check('conversation: save writes the JSON file', existsSync(saved.filePath))
  check('conversation: list returns the save', conv.list().some((c) => c.id === saved.id))
  const full = conv.get(saved.id)
  check('conversation: saved JSON embeds the raw transcript', !!full && full.transcript.includes('Pin the clock.'))
  const restoredPath = full ? conv.restoreTranscript(full) : ''
  check(
    'conversation: restore recreates a missing transcript verbatim',
    !!full && existsSync(restoredPath) && readFileSync(restoredPath, 'utf8') === full.transcript
  )
  if (full) {
    writeFileSync(restoredPath, full.transcript + JSON.stringify({ type: 'user', message: { role: 'user', content: 'newer turn' } }) + '\n')
    conv.restoreTranscript(full)
    check('conversation: restore never clobbers a longer live transcript', readFileSync(restoredPath, 'utf8').includes('newer turn'))
  }
  const renamed = conv.rename(saved.id, '  Renamed save  ')
  check(
    'conversation: rename retitles the save in place (trimmed)',
    renamed?.title === 'Renamed save' && conv.get(saved.id)?.title === 'Renamed save'
  )
  check('conversation: rename rejects an empty title', conv.rename(saved.id, '   ') === null)
  check('conversation: delete removes the save', conv.remove(saved.id) && conv.list().every((c) => c.id !== saved.id))
  const metaOnlyPath = join(dir, 'conv-empty.jsonl')
  writeFileSync(metaOnlyPath, JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'META' } }) + '\n')
  let refusedEmpty = false
  try {
    conv.save({ title: 'x', sessionId: '22222222-2222-4222-8222-222222222222', cwd: '/tmp/projA', transcriptPath: metaOnlyPath })
  } catch {
    refusedEmpty = true
  }
  check('conversation: save refuses a conversation with no real turns', refusedEmpty)
  check('conversation: get rejects a path-traversal id', conv.get('../../../evil') === null)
  const tamperedPath = join(dir, 'conversations', `${randomUUID()}.json`)
  writeFileSync(
    tamperedPath,
    JSON.stringify({ version: 1, id: 'x; rm -rf ~', sessionId: '../../escape', cwd: '/tmp', savedAt: 1, messageCount: 1, preview: '', filePath: tamperedPath, transcript: '{}' })
  )
  check('conversation: list skips a record with tampered non-UUID ids', conv.list().every((c) => c.sessionId !== '../../escape'))
  check('conversation: latest-session DB fallback resolves the tab', repo.latestSessionForTab('main')?.ccSessionId === 's2')

  // --- pinned-tab session restore (quit + reopen resumes the last session) ---
  const rTabId = 'pinned-restore'
  core.repo.createTab({ id: rTabId, spaceId: 'default', kind: 'claude', title: 'claude', cwd: process.cwd(), now: Date.now() })
  core.repo.setTabPinned(rTabId, true)
  const rTab = (): Parameters<typeof core.resumeCandidateFor>[0] => core.repo.getTab(rTabId)!
  const rTranscript = join(dir, 'restore-transcript.jsonl')
  writeFileSync(rTranscript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n')
  core.repo.insertSession({ id: 'restore-1', tabId: rTabId, ccSessionId: 'restore-1', transcriptPath: rTranscript, startedAt: Date.now(), status: 'live' })
  check('restore: pinned tab resumes its most recent session', core.resumeCandidateFor(rTab()) === 'restore-1')
  core.repo.setTabPinned(rTabId, false)
  check('restore: unpinned tab starts fresh', core.resumeCandidateFor(rTab()) === undefined)
  core.repo.setTabPinned(rTabId, true)
  core.setSettings({ restorePinnedSessions: false })
  check('restore: setting off disables auto-resume', core.resumeCandidateFor(rTab()) === undefined)
  core.setSettings({ restorePinnedSessions: true })
  core.repo.insertSession({ id: 'restore-2', tabId: rTabId, ccSessionId: 'restore-2', transcriptPath: join(dir, 'gone.jsonl'), startedAt: Date.now() + 1000, status: 'live' })
  check('restore: pruned transcript falls back to a fresh session', core.resumeCandidateFor(rTab()) === undefined)

  // --- chat prompt navigator (sidebar Prompts section) ---
  const pTabId = 'prompt-nav'
  core.repo.createTab({ id: pTabId, spaceId: 'default', kind: 'claude', title: 'chat', cwd: process.cwd(), now: Date.now() })
  const pTranscript = join(dir, 'prompts-transcript.jsonl')
  writeFileSync(
    pTranscript,
    [
      JSON.stringify({ type: 'user', timestamp: '2026-07-23T10:00:00Z', message: { role: 'user', content: 'Fix the login bug' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }),
      JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'META NOISE' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>ran</local-command-stdout>' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] } }),
      JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent prompt' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Now add tests' }] } }),
      ''
    ].join('\n')
  )
  core.repo.insertSession({ id: 'pnav-1', tabId: pTabId, ccSessionId: 'pnav-1', transcriptPath: pTranscript, startedAt: Date.now(), status: 'live' })
  const pure = userPrompts(readFileSync(pTranscript, 'utf8'))
  check('prompts: parser keeps real user prompts in order', pure.map((p) => p.text).join('|') === 'Fix the login bug|Now add tests')
  check('prompts: parser stamps recorded timestamps', pure[0]?.ts === Date.parse('2026-07-23T10:00:00Z') && pure[1]?.ts === null)
  check('prompts: parser caps a giant paste', userPrompts(JSON.stringify({ type: 'user', message: { role: 'user', content: 'y'.repeat(9000) } }))[0]?.text.length === 400)
  const pGroups = core.listPrompts('default')
  const pChat = pGroups.find((g) => g.tabId === pTabId)
  check('prompts: listPrompts groups the chat under its tab', pChat?.tabTitle === 'chat' && pChat?.prompts.length === 2)
  check('prompts: pruned/missing transcript yields no group', pGroups.every((g) => g.tabId !== rTabId))
  check('prompts: unchanged transcript served from cache', !!pChat && core.listPrompts('default').find((g) => g.tabId === pTabId)?.prompts === pChat.prompts)

  // --- M4: export ---
  const md = core.exportAll('default', 'markdown')
  check('export: markdown has a heading', md.includes('Zede memory'))
  check('export: json parses to an array', Array.isArray(JSON.parse(core.exportAll('default', 'json'))))
  core.dispose()

  // --- sync: wire format round-trip + determinism ---
  const sm: SyncedMemory = {
    id: 'cc:user-profile',
    spaceId: null,
    scope: 'global',
    type: 'preference',
    content: 'Always use pnpm, never npm.\nSecond line.',
    confidence: 0.95,
    status: 'active',
    pinned: true,
    sourceHash: fingerprint('Always use pnpm, never npm.'),
    createdAt: 1000,
    editedAt: 2000
  }
  check('sync format: serialize→parse is identity', JSON.stringify(parseMemoryFile(serializeMemory(sm))) === JSON.stringify(sm))
  const plainManifest = { formatVersion: FORMAT_VERSION, encryption: 'none' as const }
  const treeBytes = (): string => JSON.stringify([...exportTree(repo, plainManifest).entries()])
  check('sync format: export is deterministic (same DB → identical bytes)', treeBytes() === treeBytes())

  // --- sync: crypto (deterministic IV + passphrase check) ---
  const key = deriveKey('correct horse', newSalt())
  const cipher = new SyncCipher(key)
  check('sync crypto: encrypt is deterministic for same content', cipher.encrypt('hello', 'id1') === cipher.encrypt('hello', 'id1'))
  check('sync crypto: decrypt round-trips', cipher.decrypt(cipher.encrypt('hello', 'id1'), 'id1') === 'hello')
  check('sync crypto: check value verifies right key, rejects wrong', verifyCheck(key, makeCheck(key)) && !verifyCheck(deriveKey('wrong', newSalt()), makeCheck(key)))
  const encMem = parseMemoryFile(serializeMemory(sm, cipher), cipher)
  check('sync crypto: encrypted memory file round-trips with the key', encMem?.content === sm.content)
  check('sync crypto: encrypted body unreadable without the key', parseMemoryFile(serializeMemory(sm, cipher)) === null)

  // --- sync: merge semantics (importTree on a fresh repo) ---
  const mdb = new MemoryRepo(openDatabase(join(dir, 'merge.db')))
  mdb.ensureSpace('default', 'Default', 1000)
  const t = Date.now()
  const mkMem = (over: Partial<SyncedMemory>): SyncedMemory => ({ ...sm, id: 'm1', spaceId: 'default', scope: 'space', pinned: false, ...over })
  const emptyTree = { manifest: plainManifest, memories: [], tombstones: [], links: [], spaces: [], membership: [] as [string, string][], settings: {} }

  importTree(mdb, { ...emptyTree, memories: [mkMem({ content: 'v1', sourceHash: fingerprint('v1'), editedAt: t })] }, t)
  check('sync merge: unknown id inserts', mdb.getRow('m1')?.content === 'v1')
  importTree(mdb, { ...emptyTree, memories: [mkMem({ content: 'v0-older', sourceHash: fingerprint('v0'), editedAt: t - 5000 })] }, t)
  check('sync merge: older remote edit loses LWW', mdb.getRow('m1')?.content === 'v1')
  importTree(mdb, { ...emptyTree, memories: [mkMem({ content: 'v2-newer', sourceHash: fingerprint('v2'), editedAt: t + 5000 })] }, t)
  check('sync merge: newer remote edit wins LWW', mdb.getRow('m1')?.content === 'v2-newer')
  const preCount = mdb.allRows().length
  importTree(mdb, emptyTree, t)
  check('sync merge: file absence is never deletion', mdb.allRows().length === preCount && mdb.getRow('m1')?.status === 'active')

  const fpV2 = fingerprint('v2')
  importTree(mdb, { ...emptyTree, tombstones: [{ fingerprint: fpV2, scope: 'space', spaceId: 'default', reason: 'forget', createdAt: t + 6000, createdBy: 'user' }] }, t + 6000)
  check('sync merge: remote forget tombstones the local memory', mdb.getRow('m1')?.status === 'tombstoned' && mdb.isTombstoned(fpV2))
  importTree(mdb, { ...emptyTree, memories: [mkMem({ id: 'm-new', content: 'v2-newer', sourceHash: fpV2, editedAt: t + 7000 })] }, t + 7000)
  check('sync merge: never resurrect — tombstoned fingerprint blocks unknown-id insert', mdb.getRow('m-new') === undefined)
  mdb.setStatus('m1', 'active', t + 8000) // undo (bumps edited_at past the tombstone)
  importTree(mdb, { ...emptyTree, tombstones: [{ fingerprint: fpV2, scope: 'space', spaceId: 'default', reason: 'forget', createdAt: t + 6000, createdBy: 'user' }] }, t + 9000)
  check('sync merge: undo survives a stale tombstone (edit clock ≥ forget clock)', mdb.getRow('m1')?.status === 'active')

  mdb.setSetting('theme', 'nord', t)
  importTree(mdb, { ...emptyTree, settings: { theme: { value: 'dracula', editedAt: t - 1000 } } }, t)
  check('sync merge: older remote setting loses per-key LWW', mdb.getSetting('theme') === 'nord')
  importTree(mdb, { ...emptyTree, settings: { theme: { value: 'dracula', editedAt: t + 1000 }, syncGhToken: { value: 'evil', editedAt: t + 1000 } } }, t)
  check('sync merge: newer remote setting wins; non-curated keys are ignored', mdb.getSetting('theme') === 'dracula' && !mdb.getSetting('syncGhToken'))

  importTree(mdb, { ...emptyTree, spaces: [{ id: 'sp2', name: 'Work', icon: '🛠', sortOrder: 1, createdAt: t, updatedAt: t }] }, t)
  check('sync merge: unknown Space inserts', mdb.allSpaceRows().some((s) => s.id === 'sp2' && s.name === 'Work'))

  // --- sync: two-machine end-to-end over a local bare repo (real git) ---
  if (await gitAvailable()) {
    const bare = join(dir, 'remote.git')
    await run('git', ['init', '--bare', '-b', 'main', bare])
    const syncEvents = { onImported: () => {}, onStatus: () => {}, openExternal: () => {} }
    const mkMachine = (name: string): { repo: MemoryRepo; svc: SyncService } => {
      const r = new MemoryRepo(openDatabase(join(dir, name, 'zede.db')))
      r.ensureSpace('default', 'Default', Date.now())
      return { repo: r, svc: new SyncService(r, join(dir, name, 'sync'), () => Date.now(), syncEvents) }
    }
    mkdirSync(join(dir, 'A'), { recursive: true })
    mkdirSync(join(dir, 'B'), { recursive: true })
    const A = mkMachine('A')
    const B = mkMachine('B')

    const t0 = Date.now()
    for (const [i, content] of ['Fact one from A.', 'Fact two from A.', 'Fact three from A.'].entries()) {
      A.repo.insertMemory({ id: `a-${i}`, spaceId: 'default', scope: 'space', type: 'fact', content, confidence: 0.9, salience: 0.9, sourceHash: fingerprint(content), now: t0 })
    }
    const s1 = await A.svc.setup({ authMode: 'git', remoteUrl: bare })
    check('sync e2e: machine A first push succeeds', s1.ok && s1.pushed)

    const s2 = await B.svc.setup({ authMode: 'git', remoteUrl: bare })
    check('sync e2e: machine B pulls all of A', s2.ok && s2.memoriesAdded === 3 && B.repo.getRow('a-0')?.content === 'Fact one from A.')

    B.repo.editContent('a-0', 'Fact one, edited on B.', fingerprint('Fact one, edited on B.'), t0 + 5000)
    B.repo.markTombstoned('a-1', t0 + 5000)
    B.repo.insertTombstone({ id: 'tb-1', fingerprint: B.repo.getRow('a-1')!.source_hash, scope: 'space', spaceId: 'default', reason: 'forget', by: 'user', now: t0 + 5000 })
    const s3 = await B.svc.syncNow()
    check('sync e2e: B pushes its edit + forget', s3.ok && s3.pushed)

    const s4 = await A.svc.syncNow()
    check('sync e2e: A converges — edit applied', s4.ok && A.repo.getRow('a-0')?.content === 'Fact one, edited on B.')
    check('sync e2e: A converges — forget applied', A.repo.getRow('a-1')?.status === 'tombstoned' && s4.tombstonesApplied === 1)

    A.repo.setStatus('a-1', 'active', t0 + 10_000) // undo on A, after B's forget
    A.repo.deleteTombstonesByFingerprint(A.repo.getRow('a-1')!.source_hash)
    const s5 = await A.svc.syncNow()
    const s6 = await B.svc.syncNow()
    check('sync e2e: undo on A revives the memory on B (guard beats stale tombstone)', s5.ok && s6.ok && B.repo.getRow('a-1')?.status === 'active')
    const s7 = await A.svc.syncNow()
    const s8 = await B.svc.syncNow()
    check(
      'sync e2e: steady state — no-op syncs stop producing commits on both machines',
      s7.ok && s8.ok && !s8.pushed && s7.memoriesAdded + s7.memoriesUpdated + s8.memoriesAdded + s8.memoriesUpdated === 0
    )
  } else {
    console.log('  (sync e2e skipped — git not installed)')
  }

  if (process.env.ZEDE_SELFTEST_LIVE) {
    const ex = new ClaudeCodeExtractor()
    const span = 'User: I always deploy on Fridays and my editor is Helix. The DB lives at infra/db.\nAssistant: Noted.'
    const live = await ex.extract(span, { cwd: process.cwd(), spaceId: 'default' })
    check('live extractor returns >=1 candidate', live.length >= 1)
    console.log('  live candidates:', live.map((c) => `[${c.type}] ${c.content}`).join(' | ') || '(none)')
  }

  // Live end-to-end watcher: the path the unit checks above can't cover — the
  // real CaptureService tailing + backfilling a real Claude Code transcript dir
  // into a throwaway DB. Proves the Memory pane populates from prior sessions.
  // Run: ZEDE_SELFTEST_CAPTURE=1 [ZEDE_SELFTEST_CAPTURE_CWD=/path] ZEDE_SELFTEST=1 electron .
  if (process.env.ZEDE_SELFTEST_CAPTURE) {
    const capRepo = new MemoryRepo(openDatabase(join(dir, 'capture.db')))
    capRepo.ensureSpace('default', 'Default', Date.now())
    const capStore = new MemoryStore(capRepo, () => {}, () => {})
    const cap = new CaptureService(capRepo, () => new ClaudeCodeExtractor(), capStore, () => Date.now(), (m) => console.log('  [capture]', m))
    const targetCwd = process.env.ZEDE_SELFTEST_CAPTURE_CWD || process.cwd()
    console.log(`  live capture: tracking transcript dir for ${targetCwd} …`)
    cap.trackProject('default', targetCwd)
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline && capRepo.listActive('default').length === 0) await new Promise((r) => setTimeout(r, 1000))
    await new Promise((r) => setTimeout(r, 8000)) // let a couple more flushes land
    const got = capRepo.listActive('default')
    check('live capture: backfill distilled >=1 memory from real transcripts', got.length >= 1)
    console.log(`  captured ${got.length} memories from real transcripts:`)
    for (const m of got.slice(0, 12)) console.log(`    [${m.type}] ${m.content}`)
    cap.untrackAll()
  }

  console.log(ok ? '\nSELFTEST: ALL PASS ✅' : '\nSELFTEST: FAILURES ❌')
  return ok
}
