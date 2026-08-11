import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Core } from './core'
import { registerIpc } from './ipc'
import { runSelfTest } from './selftest'

let mainWindow: BrowserWindow | undefined
let core: Core | undefined

// Set this before Chromium initializes its cache and session paths.
if (process.env.ZEDE_USERDATA) {
  mkdirSync(process.env.ZEDE_USERDATA, { recursive: true, mode: 0o700 })
  app.setPath('userData', process.env.ZEDE_USERDATA)
}

function createWindow(): void {
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    show: false,
    title: 'Zede',
    icon: join(app.getAppPath(), 'build', 'icon.png'),
    backgroundColor: '#1e2228',
    // Frameless chrome so our own 38px titlebar spans the window. On macOS the
    // traffic lights stay always visible (standard behaviour), inset at the left
    // of the titlebar and vertically centred in its 38px height.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: isMac ? false : { color: '#343a45', symbolColor: '#e6e9ef', height: 38 },
    trafficLightPosition: isMac ? { x: 13, y: 13 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // The renderer never opens windows or navigates anywhere itself, so deny both
  // outright — with sandbox off (needed for the preload's node access), a
  // compromised page must not be able to load remote content in this process.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!dev) {
      e.preventDefault()
      return
    }
    try {
      if (new URL(url).origin !== new URL(dev).origin) e.preventDefault()
    } catch {
      e.preventDefault()
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // In fullscreen macOS hides the traffic lights, so the renderer reclaims the
  // space it reserves for them in the top-left chrome.
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('ui:fullScreenChanged', true))
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('ui:fullScreenChanged', false))
  let resizeEndTimer: NodeJS.Timeout | undefined
  const resizeStart = (): void => {
    mainWindow?.webContents.send('ui:windowResizing', true)
    if (resizeEndTimer) clearTimeout(resizeEndTimer)
    // Fallback for platforms that do not emit `resized`.
    resizeEndTimer = setTimeout(() => mainWindow?.webContents.send('ui:windowResizing', false), 250)
  }
  const resizeEnd = (): void => {
    if (resizeEndTimer) clearTimeout(resizeEndTimer)
    resizeEndTimer = undefined
    mainWindow?.webContents.send('ui:windowResizing', false)
  }
  mainWindow.on('will-resize', resizeStart)
  mainWindow.on('resize', resizeStart)
  mainWindow.on('resized', resizeEnd)
  mainWindow.on('closed', () => {
    if (resizeEndTimer) clearTimeout(resizeEndTimer)
    mainWindow = undefined
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// App-level view toggles. macOS uses Command; other platforms require
// Ctrl+Shift so normal terminal Ctrl keys still reach the shell.
function installMenu(): void {
  const isMac = process.platform === 'darwin'
  const toggleMemory: MenuItemConstructorOptions = {
    label: 'Toggle Memory Panel',
    accelerator: isMac ? 'Command+M' : 'Ctrl+Shift+M',
    click: () => mainWindow?.webContents.send('ui:toggleMemory')
  }
  const toggleSidebar: MenuItemConstructorOptions = {
    label: 'Toggle Spaces Sidebar',
    accelerator: isMac ? 'Command+S' : 'Ctrl+Shift+S',
    click: () => mainWindow?.webContents.send('ui:toggleSidebar')
  }
  const preferences: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => mainWindow?.webContents.send('ui:openSettings')
  }
  const clearTerminal: MenuItemConstructorOptions = {
    label: 'Clear Terminal',
    accelerator: isMac ? 'Command+K' : 'Ctrl+Shift+K',
    click: () => mainWindow?.webContents.send('ui:clearTerminal')
  }
  // macOS convention: Settings lives under the app menu (⌘,). Build a custom app
  // submenu so we can slot it in; other platforms get it at the top of View.
  const appMenu: MenuItemConstructorOptions = {
    role: 'appMenu',
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      preferences,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu] : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...(isMac ? [] : [preferences, { type: 'separator' as const }]),
        clearTerminal,
        { type: 'separator' },
        toggleSidebar,
        toggleMemory,
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        // Plain item (not role:'minimize') so it doesn't claim Cmd+M — that's
        // the Memory panel toggle now. Minimize stays clickable here and via the
        // yellow traffic-light button.
        { label: 'Minimize', click: () => mainWindow?.minimize() },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [{ role: 'close' as const }])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  // Headless verification path.
  if (process.env.ZEDE_SELFTEST) {
    const ok = await runSelfTest()
    app.exit(ok ? 0 : 1)
    return
  }

  // Dev-only: run several instances against separate data dirs (e.g. to
  // exercise sync as "two machines" on one box): ZEDE_USERDATA=/tmp/zede-b pnpm dev
  core = new Core(join(app.getPath('userData'), 'zede.db'), () => mainWindow?.webContents)
  registerIpc(core)
  // Appearance: macOS frosted-glass background. Only shows where the renderer
  // background is translucent (bgOpacity < 1); harmless when fully opaque.
  ipcMain.on('ui:setVibrancy', (_e, on: boolean) => {
    if (process.platform === 'darwin') mainWindow?.setVibrancy(on ? 'under-window' : null)
  })
  // Native macOS Emoji & Symbols picker. Inserts the chosen glyph into whatever
  // text field is focused in the renderer (used by "Change Icon…"). macOS-only.
  ipcMain.on('ui:showEmojiPanel', () => {
    if (process.platform === 'darwin') app.showEmojiPanel()
  })
  installMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  core?.dispose()
  if (process.platform !== 'darwin') app.quit()
})
