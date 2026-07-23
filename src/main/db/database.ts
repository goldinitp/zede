import Database from 'better-sqlite3'
import { chmodSync } from 'node:fs'
import { MIGRATIONS } from './migrations'

export type DB = Database.Database

export function openDatabase(path: string): DB {
  const db = new Database(path)
  // WAL so the UI reads while Core writes; single writer (spec §10).
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  try {
    chmodSync(path, 0o600) // spec §9 — DB is 0600
  } catch {
    /* best effort (e.g. :memory:) */
  }
  migrate(db)
  return db
}

function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    db.transaction(() => {
      db.exec(m.sql)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
}
