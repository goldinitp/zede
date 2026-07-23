// Appearance themes shared by the renderer: each theme supplies an xterm.js
// palette (the terminal surface) AND a set of chrome CSS variables so a selected
// theme retints the whole app, not just the terminal.
//
// The "standard terminal" redesign expresses a surface hierarchy — the terminal
// is the darkest surface, the sidebar/context chrome sits one step lighter, and
// the titlebar lighter still — so every theme provides those three tiers plus a
// text ramp and accents. Alpha-based tokens (hairlines, hover fills, accent
// tints) are derived in app.css via color-mix, so they need not be repeated here.

export interface TermTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent?: string
  selectionBackground?: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** Chrome tokens overridden per theme (a subset of the app.css :root tokens).
 *  `--term-bg` always equals `term.background` so the terminal pane's CSS
 *  padding matches the xterm surface exactly. */
export interface ChromeTheme {
  '--term-bg': string
  '--editor-header': string
  '--chrome': string
  '--titlebar-1': string
  '--titlebar-2': string
  '--text': string
  '--text-2': string
  '--text-3': string
  '--muted': string
  '--accent': string
  '--green': string
  '--amber': string
  '--red': string
}

export interface AppTheme {
  id: string
  name: string
  term: TermTheme
  chrome: ChromeTheme
}

// One Dark is the reference the redesign was derived from — ship it as default.
export const DEFAULT_THEME_ID = 'one-dark'

export const THEMES: AppTheme[] = [
  {
    id: 'one-dark',
    name: 'One Dark',
    term: {
      background: '#1e2228', foreground: '#abb2bf', cursor: '#61afef', selectionBackground: 'rgba(97,175,239,0.2)',
      black: '#1e2228', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef',
      magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
      brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b',
      brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#ffffff'
    },
    chrome: {
      '--term-bg': '#1e2228', '--editor-header': '#22262d', '--chrome': '#2c313a',
      '--titlebar-1': '#343a45', '--titlebar-2': '#2e333d',
      '--text': '#e6e9ef', '--text-2': '#b6bcc7', '--text-3': '#9aa2b1', '--muted': '#6f7686',
      '--accent': '#61afef', '--green': '#98c379', '--amber': '#e0aa48', '--red': '#e06c75'
    }
  },
  {
    id: 'zede-dark',
    name: 'Zede Dark',
    term: {
      background: '#0b0a10', foreground: '#ecebf3', cursor: '#8b9bff', selectionBackground: '#2b2a44',
      black: '#16131f', red: '#ff6f66', green: '#5ed09a', yellow: '#e8c479', blue: '#8b9bff',
      magenta: '#c49bff', cyan: '#74d0d6', white: '#d7d6e0',
      brightBlack: '#4a4860', brightRed: '#ff8a82', brightGreen: '#7fe0b4', brightYellow: '#f2d79a',
      brightBlue: '#a9b5ff', brightMagenta: '#d4b8ff', brightCyan: '#9fe6ea', brightWhite: '#ffffff'
    },
    chrome: {
      '--term-bg': '#0b0a10', '--editor-header': '#131019', '--chrome': '#1c1a28',
      '--titlebar-1': '#262336', '--titlebar-2': '#1f1c2c',
      '--text': '#ecebf3', '--text-2': '#c3c1d4', '--text-3': '#a3a1b4', '--muted': '#6f6d82',
      '--accent': '#8b9bff', '--green': '#5ed09a', '--amber': '#e0aa48', '--red': '#ff6f66'
    }
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    term: {
      background: '#002b36', foreground: '#93a1a1', cursor: '#268bd2', selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2',
      magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3'
    },
    chrome: {
      '--term-bg': '#002b36', '--editor-header': '#04333e', '--chrome': '#073642',
      '--titlebar-1': '#0a4453', '--titlebar-2': '#063d4a',
      '--text': '#eee8d5', '--text-2': '#93a1a1', '--text-3': '#839496', '--muted': '#657b83',
      '--accent': '#268bd2', '--green': '#859900', '--amber': '#b58900', '--red': '#dc322f'
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    term: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#bd93f9', selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9',
      magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff'
    },
    chrome: {
      '--term-bg': '#282a36', '--editor-header': '#2e303c', '--chrome': '#343746',
      '--titlebar-1': '#3d4152', '--titlebar-2': '#343746',
      '--text': '#f8f8f2', '--text-2': '#c9ccdf', '--text-3': '#a9adc4', '--muted': '#6272a4',
      '--accent': '#bd93f9', '--green': '#50fa7b', '--amber': '#f1fa8c', '--red': '#ff5555'
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    term: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#88c0d0', selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1',
      magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4'
    },
    chrome: {
      '--term-bg': '#2e3440', '--editor-header': '#333a47', '--chrome': '#3b4252',
      '--titlebar-1': '#434c5e', '--titlebar-2': '#3b4252',
      '--text': '#eceff4', '--text-2': '#c9d0dc', '--text-3': '#abb4c4', '--muted': '#6b7488',
      '--accent': '#88c0d0', '--green': '#a3be8c', '--amber': '#ebcb8b', '--red': '#bf616a'
    }
  }
]

export const getTheme = (id: string): AppTheme => THEMES.find((t) => t.id === id) ?? THEMES[0]

export interface FontOption {
  label: string
  value: string
}
// The default stack leads with Nerd Fonts so powerline prompts (dir/git glyphs)
// render when one is installed; it falls back to Menlo otherwise. To ship a
// bundled Nerd Font, drop a .woff2 into the renderer and add an @font-face in
// app.css whose family name matches the first entry here.
export const NERD_FONT_STACK =
  "'MesloLGS NF', 'JetBrainsMono Nerd Font', 'FiraCode Nerd Font', 'Hack Nerd Font', 'Symbols Nerd Font', ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace"

// Common terminal fonts; falls back to monospace if not installed (iTerm-style).
export const FONT_OPTIONS: FontOption[] = [
  { label: 'Nerd Font (powerline)', value: NERD_FONT_STACK },
  { label: 'Menlo', value: 'Menlo, monospace' },
  { label: 'SF Mono', value: '"SF Mono", ui-monospace, monospace' },
  { label: 'Monaco', value: 'Monaco, monospace' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", monospace' },
  { label: 'Cascadia Code', value: '"Cascadia Code", monospace' },
  { label: 'Fira Code', value: '"Fira Code", monospace' },
  { label: 'Hack', value: 'Hack, monospace' },
  { label: 'Source Code Pro', value: '"Source Code Pro", monospace' }
]
