import type { SVGProps } from 'react'

/**
 * Thin, monochrome stroke icons in the spirit of a modern browser sidebar.
 * All draw with `currentColor` so they inherit text colour, and share one
 * 16×16 viewBox with round caps/joins for the crisp hairline look. These are
 * original glyphs — no third-party assets.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Sidebar toggle — panel with a divider. */
export const IconSidebar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <line x1="6" y1="3" x2="6" y2="13" />
  </Svg>
)

/** Right-panel toggle — panel with a divider near the right edge. */
export const IconRightPanel = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <line x1="10" y1="3" x2="10" y2="13" />
  </Svg>
)

/** Git branch — two dots joined by a branch curve (powerline prompt glyph). */
export const IconGitBranch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="4" r="1.8" />
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="11" cy="6" r="1.8" />
    <path d="M5 5.8v4.4M11 7.8c0 2.4-3 2.8-4.6 3.2" />
  </Svg>
)

/** Settings gear — toothed ring with a hub (teeth attached, so it doesn't read as a sun). */
export const IconGear = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="4.5" />
    <circle cx="8" cy="8" r="1.8" />
    <path d="M8 3.5V1.9M8 14.1v-1.6M12.5 8h1.6M1.9 8h1.6M11.2 4.8l1.1-1.1M3.7 12.3l1.1-1.1M11.2 11.2l1.1 1.1M3.7 3.7l1.1 1.1" />
  </Svg>
)

/** Memory panel — stacked layers / cards. */
export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.2 14 5.3 8 8.4 2 5.3 8 2.2Z" />
    <path d="M2.4 8.3 8 11.2l5.6-2.9" />
    <path d="M2.4 11 8 13.9 13.6 11" />
  </Svg>
)

/** Plus. */
export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <line x1="8" y1="3.2" x2="8" y2="12.8" />
    <line x1="3.2" y1="8" x2="12.8" y2="8" />
  </Svg>
)

/** Globe — a Space marker. */
export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M2.5 8h11M8 2.4c1.7 1.5 2.6 3.5 2.6 5.6S9.7 12.1 8 13.6C6.3 12.1 5.4 10.1 5.4 8S6.3 3.9 8 2.4Z" />
  </Svg>
)

/** Pin / unpin. */
export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 2.6h4l-.7 3.4 2 2.2H4.7l2-2.2L6 2.6Z" />
    <line x1="8" y1="8.2" x2="8" y2="13.4" />
  </Svg>
)

/** Close / dismiss. */
export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <line x1="3.6" y1="3.6" x2="12.4" y2="12.4" />
    <line x1="12.4" y1="3.6" x2="3.6" y2="12.4" />
  </Svg>
)

/** Terminal / shell tab. */
export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M5 6.5 7.2 8 5 9.5" />
    <line x1="8.5" y1="10" x2="11" y2="10" />
  </Svg>
)

/** Sparkle — a Claude tab. */
export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.2c.5 2.6 1.2 3.3 3.8 3.8C9.2 6.5 8.5 7.2 8 9.8 7.5 7.2 6.8 6.5 4.2 6 6.8 5.5 7.5 4.8 8 2.2Z" />
    <path d="M12 9.4c.2 1.1.5 1.4 1.6 1.6-1.1.2-1.4.5-1.6 1.6-.2-1.1-.5-1.4-1.6-1.6 1.1-.2 1.4-.5 1.6-1.6Z" />
  </Svg>
)

/** Document — an internal (skill/plugin/MCP/tool) opened in a tab. */
export const IconDoc = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 2h5.4L12 4.6V14H4V2Z" />
    <path d="M9.4 2v2.6H12" />
    <line x1="6" y1="7.5" x2="10" y2="7.5" />
    <line x1="6" y1="10" x2="10" y2="10" />
  </Svg>
)

/** Chevron — collapse/expand affordances. */
/** Saved conversations — a clock rewinding (history). */
export const IconHistory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.8" />
    <path d="M2.6 2.6v2.8h2.8" />
    <path d="M8 5.4V8l2 1.4" />
  </Svg>
)

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.5 10.5 8 6 12.5" />
  </Svg>
)

/** Chevron (left) — collapse the left sidebar. */
export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 3.5 5.5 8 10 12.5" />
  </Svg>
)
