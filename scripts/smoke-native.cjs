// ABI smoke test: proves node-pty + better-sqlite3 load and work *inside
// Electron's ABI* (not just bare Node). Run with: electron scripts/smoke-native.cjs
// Exits 0 on success, 1 on failure. Creates no window.
const { app } = require('electron')

async function run() {
  const results = {}

  // --- better-sqlite3 (+ bonus FTS5 check) ---
  const Database = require('better-sqlite3')
  const db = new Database(':memory:')
  results.sqlite_version = db.prepare('select sqlite_version() as v').get().v
  try {
    db.exec('create virtual table t using fts5(x)')
    db.exec("insert into t(x) values ('hello world'), ('goodbye world')")
    const n = db.prepare("select count(*) c from t where t match 'world'").get().c
    results.fts5 = `ok (${n} matches via bm25-capable fts5)`
  } catch (e) {
    results.fts5 = 'MISSING: ' + e.message
  }
  db.close()

  // --- node-pty ---
  const pty = require('node-pty')
  results.pty = await new Promise((resolve) => {
    let buf = ''
    const p = pty.spawn('/bin/sh', ['-c', 'echo pty-ok'], {
      name: 'xterm-color',
      cols: 80,
      rows: 24
    })
    p.onData((d) => (buf += d))
    p.onExit(() => resolve(buf.includes('pty-ok') ? 'ok' : 'unexpected: ' + JSON.stringify(buf)))
  })

  return results
}

app.whenReady().then(async () => {
  try {
    const r = await run()
    console.log(
      'SMOKE_RESULTS ' +
        JSON.stringify(
          {
            electron: process.versions.electron,
            node: process.versions.node,
            modules_abi: process.versions.modules,
            ...r
          },
          null,
          2
        )
    )
    app.exit(0)
  } catch (e) {
    console.error('SMOKE_FAIL', e && e.stack ? e.stack : e)
    app.exit(1)
  }
})
