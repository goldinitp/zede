import { ipcMain } from 'electron'
import type { Core } from './core'
import type {
  PtyInputPayload,
  PtyKillPayload,
  PtyResizePayload,
  PtySnapshot,
  Settings,
  SyncSetupOptions,
  TabCreateOptions,
  TabKind
} from '../shared/api'

export function registerIpc(core: Core): void {
  ipcMain.handle('ping', () => 'pong')

  // --- pty ---
  ipcMain.handle('pty:spawn', (_e, opts: { tabId: string; spaceId?: string; cwd?: string; kind?: TabKind; autoClaude?: boolean }) =>
    core.spawnTab(opts)
  )
  ipcMain.on('pty:input', (_e, p: PtyInputPayload) => core.pty.input(p.tabId, p.data))
  ipcMain.on('pty:resize', (_e, p: PtyResizePayload) => core.pty.resize(p.tabId, p.cols, p.rows))
  ipcMain.on('pty:kill', (_e, p: PtyKillPayload) => core.pty.kill(p.tabId))
  ipcMain.on('pty:snapshot', (_e, p: { tabId: string; snap: PtySnapshot }) => core.saveSnapshot(p.tabId, p.snap))
  ipcMain.handle('pty:getSnapshot', (_e, tabId: string) => core.getSnapshot(tabId))

  // --- spaces ---
  ipcMain.handle('space:list', () => core.listSpaces())
  ipcMain.handle('space:create', (_e, p: { name: string; icon?: string }) => core.createSpace(p.name, p.icon))
  ipcMain.handle('space:rename', (_e, p: { id: string; name: string }) => core.renameSpace(p.id, p.name))
  ipcMain.handle('space:setIcon', (_e, p: { id: string; icon: string }) => core.setSpaceIcon(p.id, p.icon))
  ipcMain.handle('space:remove', (_e, id: string) => core.removeSpace(id))
  ipcMain.handle('space:reorder', (_e, ids: string[]) => core.reorderSpaces(ids))
  ipcMain.handle('space:getActive', () => core.getActiveSpace())
  ipcMain.handle('space:setActive', (_e, id: string) => core.setActiveSpace(id))
  ipcMain.handle('space:setDefault', (_e, id: string) => core.setDefaultSpace(id))

  // --- tabs ---
  ipcMain.handle('tab:list', (_e, spaceId: string) => core.listTabs(spaceId))
  ipcMain.handle('tab:create', (_e, opts: TabCreateOptions) => core.createTab(opts))
  ipcMain.handle('tab:close', (_e, id: string) => core.closeTab(id))
  ipcMain.handle('tab:closeAll', (_e, spaceId: string) => core.closeAllTabs(spaceId))
  ipcMain.handle('tab:rename', (_e, p: { id: string; title: string }) => core.renameTab(p.id, p.title))
  ipcMain.handle('tab:setPinned', (_e, p: { id: string; pinned: boolean }) => core.setTabPinned(p.id, p.pinned))
  ipcMain.handle('tab:reorder', (_e, p: { spaceId: string; ids: string[] }) => core.reorderTabs(p.spaceId, p.ids))
  ipcMain.handle('tab:duplicate', (_e, id: string) => core.duplicateTab(id))
  ipcMain.handle('tab:move', (_e, p: { id: string; spaceId: string }) => core.moveTab(p.id, p.spaceId))

  // --- memory ---
  ipcMain.handle('memory:list', (_e, spaceId: string) => core.listMemories(spaceId))
  ipcMain.handle('memory:search', (_e, p: { spaceId: string; q: string }) => core.searchMemories(p.spaceId, p.q))
  ipcMain.handle('memory:delete', (_e, p: { id: string; hard?: boolean }) => core.deleteMemory(p.id, p.hard))
  ipcMain.handle('memory:undo', (_e, id: string) => core.undoMemory(id))
  ipcMain.handle('memory:setPinned', (_e, p: { id: string; pinned: boolean }) => core.setMemoryPinned(p.id, p.pinned))
  ipcMain.handle('memory:edit', (_e, p: { id: string; content: string }) => core.editMemory(p.id, p.content))
  ipcMain.handle('memory:preview', (_e, spaceId: string) => core.previewInjection(spaceId))
  ipcMain.handle('memory:forgetAboutPreview', (_e, p: { spaceId: string; query: string }) =>
    core.forgetAboutPreview(p.spaceId, p.query)
  )
  ipcMain.handle('memory:forgetAboutConfirm', (_e, p: { spaceId: string; query: string }) =>
    core.forgetAboutConfirm(p.spaceId, p.query)
  )
  ipcMain.handle('memory:recentlyForgotten', (_e, spaceId: string) => core.recentlyForgotten(spaceId))
  ipcMain.handle('memory:history', (_e, id: string) => core.history(id))
  ipcMain.handle('memory:shareToSpace', (_e, p: { id: string; spaceId: string }) => core.shareToSpace(p.id, p.spaceId))
  ipcMain.handle('memory:detail', (_e, id: string) => core.memoryDetail(id))
  ipcMain.handle('memory:rebuild', (_e, spaceId: string) => core.resyncMirror(spaceId))
  ipcMain.handle('memory:export', (_e, p: { spaceId: string; format: 'json' | 'markdown' }) =>
    core.exportAll(p.spaceId, p.format)
  )
  ipcMain.handle('memory:exportSave', (_e, p: { spaceId: string; format: 'json' | 'markdown' }) =>
    core.exportSave(p.spaceId, p.format)
  )

  // --- saved conversations ---
  ipcMain.handle('conversation:save', (_e, p: { tabId: string; title?: string }) => core.saveConversation(p.tabId, p.title))
  ipcMain.handle('conversation:list', () => core.listConversations())
  ipcMain.handle('conversation:rename', (_e, p: { id: string; title: string }) => core.conversations.rename(p.id, p.title))
  ipcMain.handle('conversation:load', (_e, p: { id: string; spaceId?: string; compact?: boolean }) =>
    core.loadConversation(p.id, { spaceId: p.spaceId, compact: p.compact })
  )
  ipcMain.handle('conversation:delete', (_e, id: string) => core.deleteConversation(id))

  // --- chat prompt navigator ---
  ipcMain.handle('prompts:list', (_e, spaceId: string) => core.listPrompts(spaceId))

  // --- Claude internals ---
  ipcMain.handle('internals:list', (_e, spaceId: string) => core.listInternals(spaceId))
  ipcMain.handle('internals:detail', (_e, p: { spaceId: string; id: string }) => core.internalDetail(p.spaceId, p.id))
  ipcMain.handle('internals:save', (_e, p: { spaceId: string; id: string; content: string }) =>
    core.internalSave(p.spaceId, p.id, p.content)
  )

  // --- settings ---
  ipcMain.handle('settings:get', () => core.getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => core.setSettings(patch))

  // --- sync (user-owned git-backed sync) ---
  ipcMain.handle('sync:status', () => core.sync.status())
  ipcMain.handle('sync:loginStart', () => core.sync.loginStart())
  ipcMain.handle('sync:loginCancel', () => core.sync.loginCancel())
  ipcMain.handle('sync:setup', (_e, opts: SyncSetupOptions) => core.sync.setup(opts))
  ipcMain.handle('sync:now', () => core.sync.syncNow())
  ipcMain.handle('sync:unlock', (_e, passphrase: string) => core.sync.unlock(passphrase))
  ipcMain.handle('sync:disconnect', (_e, deleteFiles?: boolean) => core.sync.disconnect(deleteFiles))
  ipcMain.handle('sync:open', (_e, p: { target: 'new-repo' | 'install'; repoName?: string }) =>
    core.sync.open(p.target, p.repoName)
  )
}
