import { execFile } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'

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

/** Executable name of the foreground process on a shell's controlling tty.
 *  node-pty's `process` getter reads the process TITLE, and claude rewrites its
 *  title to a bare version string ("2.1.220") — so the sidebar's icon logic
 *  can't trust it. The OS knows the real image name: the tty's foreground
 *  process group (tpgid), whose leader's comm is what's actually running.
 *  Null on failure or unsupported platform (Windows ConPTY has no equivalent;
 *  the caller keeps node-pty's answer). */
export async function foregroundProc(shellPid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${shellPid}/stat`, 'utf8')
      // Fields after the parenthesized comm (which may itself contain spaces
      // or parens, so parse from the LAST ')'): state ppid pgrp session tty_nr tpgid.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const tpgid = Number(rest[5])
      if (!Number.isFinite(tpgid) || tpgid <= 0) return null
      return ((await readFile(`/proc/${tpgid}/comm`, 'utf8')).trim() || null)
    } catch {
      return null
    }
  }
  if (process.platform === 'darwin') {
    const tpgid = await psField(shellPid, 'tpgid')
    const pid = Number(tpgid)
    if (!Number.isFinite(pid) || pid <= 0) return null
    return psField(pid, 'comm')
  }
  return null
}

function psField(pid: number, field: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-p', String(pid), '-o', `${field}=`], { timeout: 3000 }, (err, out) => {
      resolve(err ? null : out.trim() || null)
    })
  })
}
