import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ZedeApi,
  Memory,
  PtyDataEvent,
  PtyExitEvent,
  PtySnapshot,
  PtySpawnOptions,
  Settings,
  SyncSetupOptions,
  SyncStatus,
  TabCreateOptions
} from '../shared/api'

const sub = <T>(channel: string, cb: (p: T) => void): (() => void) => {
  const h = (_e: IpcRendererEvent, p: T): void => cb(p)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.off(channel, h)
}

const api: ZedeApi = {
  ping: () => ipcRenderer.invoke('ping'),
  pty: {
    spawn: (opts: PtySpawnOptions) => ipcRenderer.invoke('pty:spawn', opts),
    input: (tabId, data) => ipcRenderer.send('pty:input', { tabId, data }),
    resize: (tabId, cols, rows) => ipcRenderer.send('pty:resize', { tabId, cols, rows }),
    kill: (tabId) => ipcRenderer.send('pty:kill', { tabId }),
    snapshot: (tabId, snap: PtySnapshot) => ipcRenderer.send('pty:snapshot', { tabId, snap }),
    getSnapshot: (tabId) => ipcRenderer.invoke('pty:getSnapshot', tabId),
    onData: (cb) => sub<PtyDataEvent>('pty:data', cb),
    onExit: (cb) => sub<PtyExitEvent>('pty:exit', cb)
  },
  space: {
    list: () => ipcRenderer.invoke('space:list'),
    create: (name, icon) => ipcRenderer.invoke('space:create', { name, icon }),
    rename: (id, name) => ipcRenderer.invoke('space:rename', { id, name }),
    setIcon: (id, icon) => ipcRenderer.invoke('space:setIcon', { id, icon }),
    remove: (id) => ipcRenderer.invoke('space:remove', id),
    reorder: (ids) => ipcRenderer.invoke('space:reorder', ids),
    getActive: () => ipcRenderer.invoke('space:getActive'),
    setActive: (id) => ipcRenderer.invoke('space:setActive', id),
    setDefault: (id) => ipcRenderer.invoke('space:setDefault', id),
    onChanged: (cb) => sub<null>('space:changed', () => cb())
  },
  tab: {
    list: (spaceId) => ipcRenderer.invoke('tab:list', spaceId),
    create: (opts: TabCreateOptions) => ipcRenderer.invoke('tab:create', opts),
    close: (id) => ipcRenderer.invoke('tab:close', id),
    closeAll: (spaceId) => ipcRenderer.invoke('tab:closeAll', spaceId),
    rename: (id, title) => ipcRenderer.invoke('tab:rename', { id, title }),
    setPinned: (id, pinned) => ipcRenderer.invoke('tab:setPinned', { id, pinned }),
    reorder: (spaceId, ids) => ipcRenderer.invoke('tab:reorder', { spaceId, ids }),
    duplicate: (id) => ipcRenderer.invoke('tab:duplicate', id),
    move: (id, spaceId) => ipcRenderer.invoke('tab:move', { id, spaceId }),
    onChanged: (cb) => sub<string>('tab:changed', cb)
  },
  memory: {
    list: (spaceId) => ipcRenderer.invoke('memory:list', spaceId),
    search: (spaceId, q) => ipcRenderer.invoke('memory:search', { spaceId, q }),
    delete: (id, hard) => ipcRenderer.invoke('memory:delete', { id, hard }),
    undo: (id) => ipcRenderer.invoke('memory:undo', id),
    setPinned: (id, pinned) => ipcRenderer.invoke('memory:setPinned', { id, pinned }),
    edit: (id, content) => ipcRenderer.invoke('memory:edit', { id, content }),
    preview: (spaceId) => ipcRenderer.invoke('memory:preview', spaceId),
    forgetAboutPreview: (spaceId, query) => ipcRenderer.invoke('memory:forgetAboutPreview', { spaceId, query }),
    forgetAboutConfirm: (spaceId, query) => ipcRenderer.invoke('memory:forgetAboutConfirm', { spaceId, query }),
    recentlyForgotten: (spaceId) => ipcRenderer.invoke('memory:recentlyForgotten', spaceId),
    history: (id) => ipcRenderer.invoke('memory:history', id),
    shareToSpace: (id, spaceId) => ipcRenderer.invoke('memory:shareToSpace', { id, spaceId }),
    detail: (id) => ipcRenderer.invoke('memory:detail', id),
    rebuild: (spaceId) => ipcRenderer.invoke('memory:rebuild', spaceId),
    exportAll: (spaceId, format) => ipcRenderer.invoke('memory:export', { spaceId, format }),
    exportSave: (spaceId, format) => ipcRenderer.invoke('memory:exportSave', { spaceId, format }),
    onLearned: (cb) => sub<Memory>('memory:learned', cb),
    onForgotten: (cb) => sub<{ id: string }>('memory:forgotten', (p) => cb(p.id)),
    onChanged: (cb) => sub<null>('memory:changed', () => cb())
  },
  conversation: {
    save: (tabId, title) => ipcRenderer.invoke('conversation:save', { tabId, title }),
    list: () => ipcRenderer.invoke('conversation:list'),
    rename: (id, title) => ipcRenderer.invoke('conversation:rename', { id, title }),
    load: (id, opts) => ipcRenderer.invoke('conversation:load', { id, ...opts }),
    delete: (id) => ipcRenderer.invoke('conversation:delete', id)
  },
  internals: {
    list: (spaceId) => ipcRenderer.invoke('internals:list', spaceId),
    detail: (spaceId, id) => ipcRenderer.invoke('internals:detail', { spaceId, id }),
    save: (spaceId, id, content) => ipcRenderer.invoke('internals:save', { spaceId, id, content })
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch),
    onChanged: (cb) => sub<Settings>('settings:changed', cb)
  },
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    loginStart: () => ipcRenderer.invoke('sync:loginStart'),
    loginCancel: () => ipcRenderer.invoke('sync:loginCancel'),
    setup: (opts: SyncSetupOptions) => ipcRenderer.invoke('sync:setup', opts),
    now: () => ipcRenderer.invoke('sync:now'),
    unlock: (passphrase) => ipcRenderer.invoke('sync:unlock', passphrase),
    disconnect: (deleteFiles) => ipcRenderer.invoke('sync:disconnect', deleteFiles),
    open: (target, repoName) => ipcRenderer.invoke('sync:open', { target, repoName }),
    onStatus: (cb) => sub<SyncStatus>('sync:status', cb)
  },
  ui: {
    onToggleMemory: (cb) => sub<null>('ui:toggleMemory', () => cb()),
    onToggleSidebar: (cb) => sub<null>('ui:toggleSidebar', () => cb()),
    onOpenSettings: (cb) => sub<null>('ui:openSettings', () => cb()),
    setVibrancy: (on: boolean) => ipcRenderer.send('ui:setVibrancy', on),
    onFullScreenChanged: (cb) => sub<boolean>('ui:fullScreenChanged', cb),
    showEmojiPanel: () => ipcRenderer.send('ui:showEmojiPanel')
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('zede', api)
} else {
  // @ts-expect-error -- define on window when context isolation is off
  window.zede = api
}
