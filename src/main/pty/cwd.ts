import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'

/** Current working directory of a live process — the shell behind a tab's PTY.
 *  Darwin has no /proc, so lsof does the lookup. Unsupported platforms (and any
 *  lookup failure) resolve null; the caller keeps the tab's recorded cwd. */
export function processCwd(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    return readlink(`/proc/${pid}/cwd`).catch(() => null)
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 }, (err, out) => {
        if (err) return resolve(null)
        const line = out.split('\n').find((l) => l.startsWith('n'))
        resolve(line ? line.slice(1) : null)
      })
    })
  }
  return Promise.resolve(null)
}
