import type { Settings } from '../shared/api'
import { THEMES } from '../shared/themes'

const THEME_IDS = new Set(THEMES.map((theme) => theme.id))
const BOOLEAN_KEYS = new Set(['semanticEnabled', 'restorePinnedSessions', 'cursorBlink', 'bgBlur'])

function number(value: string, min: number, max: number, integer = false): string | undefined {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return undefined
  const clamped = Math.min(max, Math.max(min, parsed))
  return String(integer ? Math.round(clamped) : clamped)
}

/** Validate the string form stored in SQLite and received from sync. */
export function normalizeSettingValue(key: string, value: string): string | undefined {
  if (BOOLEAN_KEYS.has(key)) return value === '1' || value === '0' ? value : undefined
  if (key === 'injectionAdapter') return value === 'file' || value === 'flag' ? value : undefined
  if (key === 'extractionTier') return ['claude', 'heuristic', 'ollama'].includes(value) ? value : undefined
  if (key === 'cursorStyle') return ['block', 'underline', 'bar'].includes(value) ? value : undefined
  if (key === 'theme') return THEME_IDS.has(value) ? value : undefined
  if (key === 'embedTier') return value === 'hashing' || value === 'transformers' ? value : undefined
  if (key === 'fontFamily') {
    const clean = value.trim()
    return clean && clean.length <= 256 ? clean : undefined
  }
  if (key === 'fontSize') return number(value, 9, 24)
  if (key === 'lineHeight') return number(value, 1, 2)
  if (key === 'letterSpacing') return number(value, 0, 4)
  if (key === 'scrollback') return number(value, 500, 50_000, true)
  if (key === 'bgOpacity') return number(value, 0.5, 1)
  return undefined
}

/** Whitelist renderer settings before they reach the database. */
export function normalizeSettingsPatch(patch: Partial<Settings>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(patch)) {
    const value = typeof raw === 'boolean' ? (raw ? '1' : '0') : String(raw)
    const normalized = normalizeSettingValue(key, value)
    if (normalized !== undefined) out[key] = normalized
  }
  return out
}
