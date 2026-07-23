# Zede ↔ Arc / iTerm parity map

Zede is a **terminal shell for orchestrating Claude Code sessions**, dressed in
Arc's sidebar-centric design language. So we map Arc's *interaction patterns*
(not its web features) onto terminal/Claude concepts, and borrow iTerm's
appearance/profile model for the terminal surface.

Legend: ✅ done · 🟡 partial · ⬜ planned · ⛔ N/A for a terminal app

## Arc → Zede

| Arc concept | Zede equivalent | State |
|---|---|---|
| Spaces | Spaces (per-Space tabs + memory) | ✅ |
| Sidebar (pinned tiles, tab list, space switcher) | Sidebar | ✅ |
| Pinned tabs / Favorites | Pinned tabs (grid tiles) | ✅ |
| Drag to reorder / pin / unpin | HTML5 DnD across both zones | ✅ |
| Persistent "favorites" area | Always-shown pinned zone w/ placeholder | ✅ |
| Closing a pinned tab keeps the favorite | Close keeps pin, resets the session | ✅ |
| Tab right-click menu (Rename, Duplicate, Move to, …) | Tab context menu | ✅ Rename/Duplicate/Copy cwd/Move to Space/Pin/Close |
| Change Icon (per tab) | per-tab emoji icon | ⬜ (needs `tabs.icon` column) |
| Space right-click (rename / icon / delete) | Space header context menu | ✅ |
| New Tab (⌘T) | ⌘T → new claude tab | ✅ |
| Close Tab (⌘W) | ⌘W → close active (pinned keeps slot) | ✅ |
| Command bar / palette (⌘T, ⌘L) | fuzzy command + tab/space switcher | ⬜ |
| Split View | split terminal panes (2-up / grid) | ⬜ |
| Archive tabs after N hours | auto-close idle unpinned tabs | ⬜ |
| Clear all tabs | "Clear" (keeps pinned) | ✅ |
| Tab folders / groups | tab grouping | ⬜ |
| Little Arc / peek | — | ⛔ |
| Boosts (per-site CSS/JS) | — | ⛔ |
| Easels / Notes | Memory pane (distilled, deletable) | 🟡 (different concept, intentional) |
| Theme / appearance | iTerm-style appearance settings | ⬜ (see below) |
| Preferences (⌘,) | Settings under app menu (⌘,) | ✅ |

## iTerm → Zede (terminal appearance / profiles)

| iTerm setting | Zede plan | State |
|---|---|---|
| Profiles > Text > Font family | Font picker (monospace list + custom) | ⬜ |
| Profiles > Text > Font size | Font size stepper | ⬜ |
| Profiles > Text > line height / ligatures | line-height, ligatures toggle | ⬜ |
| Profiles > Colors > preset schemes | Built-in themes (Zede Dark, Solarized, Dracula, …) applied to xterm + chrome | ⬜ |
| Cursor style / blink | cursor style + blink toggle | 🟡 (blink on, style hardcoded) |
| Window > transparency / blur | optional background blur | ⬜ |
| Settings persistence | `app_settings` table (already used) | ✅ infra |

Today the terminal hardcodes font/theme in `terminal/Terminal.tsx`. The plan is
to add an **Appearance** section to Settings, persist via the existing settings
store, and have `TerminalPane` read + live-apply font and theme (and reflect the
theme into the app's CSS variables).

## Memory (not an Arc feature — Zede's core)

The capture → extract → store pipeline is verified working end-to-end
(`ZEDE_SELFTEST=1 ZEDE_SELFTEST_LIVE=1 electron .`, 47/47 + live extractor).
Memories are produced **from real Claude conversations inside a Zede-spawned
`claude` tab** (transcript tailed, debounced ~4s, distilled). They do not appear
until you actually converse in a Zede tab — opening a tab without chatting yields
nothing by design.

## Suggested build order

1. **Appearance settings** (fonts + theme presets) — most-requested, self-contained.
2. **Per-tab Change Icon** — small; completes the Arc tab menu.
3. **Command palette (⌘K/⌘P)** — switch tabs/spaces, run actions.
4. **Split View** — 2-up terminal panes; larger layout change.
5. **Auto-archive idle tabs** + tab folders — housekeeping parity.
