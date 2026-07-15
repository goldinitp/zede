import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync } from 'node:crypto'
import type { BodyCipher } from './format'

// Opt-in passphrase encryption for synced memory bodies (Node built-ins only).
// Frontmatter/ids/timestamps stay plaintext so LWW merge never needs the key.
// The IV is derived from HMAC(key, id ‖ sha256(plaintext)) rather than random:
// unchanged content encrypts to identical bytes, preserving the "no-op sync →
// no git diff" invariant. Deterministic encryption leaks content-equality
// across history, which git diffs would reveal anyway.

const CHECK_PLAINTEXT = 'zede-sync-check-v1'
const CHECK_ID = 'zede.json'

export function newSalt(): string {
  return randomBytes(16).toString('base64')
}

export function deriveKey(passphrase: string, saltB64: string): Buffer {
  return scryptSync(passphrase, Buffer.from(saltB64, 'base64'), 32)
}

export class SyncCipher implements BodyCipher {
  constructor(private readonly key: Buffer) {}

  encrypt(plaintext: string, id: string): string {
    const contentHash = createHash('sha256').update(plaintext, 'utf8').digest()
    const iv = createHmac('sha256', this.key).update(id).update(contentHash).digest().subarray(0, 12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')
  }

  decrypt(token: string, _id: string): string {
    const buf = Buffer.from(token, 'base64')
    if (buf.length < 12 + 16) throw new Error('cipher token too short')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
  }
}

/** Opaque token stored in zede.json so a new machine can verify the passphrase
 *  before importing anything (wrong passphrase → clear error, no import). */
export function makeCheck(key: Buffer): string {
  return new SyncCipher(key).encrypt(CHECK_PLAINTEXT, CHECK_ID)
}

export function verifyCheck(key: Buffer, check: string): boolean {
  try {
    return new SyncCipher(key).decrypt(check, CHECK_ID) === CHECK_PLAINTEXT
  } catch {
    return false
  }
}
