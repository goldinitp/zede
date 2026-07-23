import { useEffect, useState } from 'react'
import type { CursorStyle, Settings } from '@shared/api'
import { FONT_OPTIONS, THEMES } from '@shared/themes'
import { SyncSection } from './SyncSection'

// Honest egress posture per extraction tier (spec §9).
const EGRESS: Record<Settings['extractionTier'], string> = {
  claude: 'Transcript spans are sent to Anthropic for extraction, reusing your existing Claude Code auth. No other network calls.',
  heuristic: 'Fully local — regex extraction, zero network calls.',
  ollama: 'Local only — talks to the Ollama daemon at 127.0.0.1:11434. Nothing leaves the machine.'
}

export function SettingsPanel({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null)
  const [savedTo, setSavedTo] = useState<string | null>(null)

  useEffect(() => {
    window.zede.settings.get().then(setS)
    return window.zede.settings.onChanged(setS)
  }, [])

  if (!s) return null
  const patch = (p: Partial<Settings>): void => {
    window.zede.settings.set(p).then(setS)
  }
  const exportTo = (format: 'json' | 'markdown'): void => {
    window.zede.memory.exportSave(spaceId, format).then((p) => p && setSavedTo(p))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Settings</h3>
          <button className="modal-x" onClick={onClose}>
            ✕
          </button>
        </div>

        <h4 className="modal-group">Appearance</h4>
        <label className="field">
          <span>Theme</span>
          <select value={s.theme} onChange={(e) => patch({ theme: e.target.value })}>
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Font</span>
          <select value={s.fontFamily} onChange={(e) => patch({ fontFamily: e.target.value })}>
            {!FONT_OPTIONS.some((f) => f.value === s.fontFamily) && <option value={s.fontFamily}>Current</option>}
            {FONT_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Font size — {s.fontSize}px</span>
          <input
            type="range"
            min={9}
            max={24}
            step={1}
            value={s.fontSize}
            onChange={(e) => patch({ fontSize: Number(e.target.value) })}
          />
        </label>

        <label className="field">
          <span>Line spacing — {s.lineHeight.toFixed(2)}×</span>
          <input
            type="range"
            min={1}
            max={2}
            step={0.05}
            value={s.lineHeight}
            onChange={(e) => patch({ lineHeight: Number(e.target.value) })}
          />
        </label>

        <label className="field">
          <span>Letter spacing — {s.letterSpacing}px</span>
          <input
            type="range"
            min={0}
            max={4}
            step={0.5}
            value={s.letterSpacing}
            onChange={(e) => patch({ letterSpacing: Number(e.target.value) })}
          />
        </label>

        <label className="field">
          <span>Scrollback — {s.scrollback.toLocaleString()} lines</span>
          <input
            type="range"
            min={500}
            max={50000}
            step={500}
            value={s.scrollback}
            onChange={(e) => patch({ scrollback: Number(e.target.value) })}
          />
        </label>

        <label className="field">
          <span>Cursor</span>
          <select value={s.cursorStyle} onChange={(e) => patch({ cursorStyle: e.target.value as CursorStyle })}>
            <option value="block">Block</option>
            <option value="bar">Bar</option>
            <option value="underline">Underline</option>
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={s.cursorBlink} onChange={(e) => patch({ cursorBlink: e.target.checked })} />
          <span>Blinking cursor</span>
        </label>

        <label className="field">
          <span>Background opacity — {Math.round(s.bgOpacity * 100)}%</span>
          <input
            type="range"
            min={0.5}
            max={1}
            step={0.02}
            value={s.bgOpacity}
            onChange={(e) => patch({ bgOpacity: Number(e.target.value) })}
          />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={s.bgBlur} onChange={(e) => patch({ bgBlur: e.target.checked })} />
          <span>
            Background blur <em>(macOS frosted glass; shows when opacity &lt; 100%)</em>
          </span>
        </label>

        <h4 className="modal-group">Memory &amp; capture</h4>
        <label className="field">
          <span>Extraction tier</span>
          <select value={s.extractionTier} onChange={(e) => patch({ extractionTier: e.target.value as Settings['extractionTier'] })}>
            <option value="claude">claude -p (best quality)</option>
            <option value="heuristic">heuristic (offline, zero-dep)</option>
            <option value="ollama">ollama (local daemon)</option>
          </select>
        </label>
        <div className="egress">🛰 {EGRESS[s.extractionTier]}</div>

        <label className="field">
          <span>Injection adapter</span>
          <select value={s.injectionAdapter} onChange={(e) => patch({ injectionAdapter: e.target.value as Settings['injectionAdapter'] })}>
            <option value="file">.zede/context.md + CLAUDE.md @import (inspectable)</option>
            <option value="flag">--append-system-prompt-file (no repo edits)</option>
          </select>
        </label>

        <label className="toggle">
          <input type="checkbox" checked={s.semanticEnabled} onChange={(e) => patch({ semanticEnabled: e.target.checked })} />
          <span>Semantic ranking &amp; search (embeddings)</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={s.pinnedTabPinsMemory} onChange={(e) => patch({ pinnedTabPinsMemory: e.target.checked })} />
          <span>Pinning a tab pins its Space’s memories</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={s.restorePinnedSessions}
            onChange={(e) => patch({ restorePinnedSessions: e.target.checked })}
          />
          <span>
            Pinned tabs resume their last Claude session on relaunch <em>(quit + reopen picks the conversation back up)</em>
          </span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={s.encryptionEnabled} onChange={(e) => patch({ encryptionEnabled: e.target.checked })} />
          <span>
            Encryption at rest <em>(stores a keychain-protected key; full SQLCipher needs the multiple-ciphers build)</em>
          </span>
        </label>

        <h4 className="modal-group">Sync</h4>
        <SyncSection />

        <div className="modal-section">
          <span>Export this Space’s memories</span>
          <div className="row">
            <button onClick={() => exportTo('json')}>Export JSON…</button>
            <button onClick={() => exportTo('markdown')}>Export Markdown…</button>
          </div>
          {savedTo && <div className="saved">Saved → {savedTo}</div>}
        </div>

        <div className="modal-foot">
          Zede’s only egress: the extraction tier above, and — only when you set it up — sync to your own GitHub repo.
        </div>
      </div>
    </div>
  )
}
