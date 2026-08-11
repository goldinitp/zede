import Database from 'better-sqlite3'
import { chmodSync } from 'node:fs'
import { MIGRATIONS } from './migrations'

export type DB = Database.Database

export function openDatabase(path: string): DB {
  const db = new Database(path)
  // WAL lets reads continue while Core writes.
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best effort (e.g. :memory:) */
  }
  migrate(db)
  cachePreparedStatements(db)
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

/** better-sqlite3 compiles SQL synchronously. The schema is immutable after
 * migrate(), and callers never mutate Statement modes, so reuse statements
 * across the repository's high-frequency capture/settings/embedding calls. */
function cachePreparedStatements(db: DB): void {
  const original = db.prepare.bind(db)
  const cache = new Map<string, Database.Statement>()
  const cached = ((sql: string) => {
    let statement = cache.get(sql)
    if (!statement) {
      statement = original(sql)
      cache.set(sql, statement)
    }
    return statement
  }) as DB['prepare']
  Object.defineProperty(db, 'prepare', { configurable: true, value: cached })
}
