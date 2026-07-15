import { join } from 'node:path'
import { homedir } from 'node:os'

// Session and conversation ids are always v4 UUIDs (ours via randomUUID, claude's
// own likewise). Anything else is a tampered or corrupt record — reject it before
// the id reaches a shell string or a filesystem path.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: string): boolean => UUID_RE.test(s)

// Lossy/non-invertible forward encoder (every non-alphanumeric -> '-').
// Confirmed in M0 Spike 2. Only ever compute forward from a known cwd.
export const encodeCwd = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

export function transcriptDirFor(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwd(cwd))
}

export function transcriptPathFor(cwd: string, sessionId: string): string {
  return join(transcriptDirFor(cwd), `${sessionId}.jsonl`)
}
