import type { Settings } from '@shared/api'
import { getTheme } from '@shared/themes'

/** #rrggbb -> rgba(r,g,b,a). Falls back to the hex unchanged if not parseable. */
function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

/**
 * Apply the chosen theme + background translucency to the whole app chrome by
 * setting CSS variables on :root. Background layers are alpha-composited from
 * the theme so the macOS vibrancy (and desktop) shows through when opacity < 1.
 * The terminal palette is applied separately in TerminalPane.
 */
export function applyAppearance(s: Settings): void {
  const root = document.documentElement
  const t = getTheme(s.theme)
  for (const [k, v] of Object.entries(t.chrome)) root.style.setProperty(k, v)

  const a = s.bgOpacity
  root.style.setProperty('--app-bg', hexToRgba(t.chrome['--term-bg'], a))
  root.style.setProperty('--app-bg-1', hexToRgba(t.chrome['--titlebar-1'], a))
  root.style.setProperty('--card-bg', hexToRgba(t.chrome['--term-bg'], a))

  // Frosted glass only makes sense when the background is actually translucent.
  window.zede.ui.setVibrancy(s.bgBlur && a < 1)
}
