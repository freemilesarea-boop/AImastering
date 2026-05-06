/**
 * Electron 메인 프로세스 진입점 v2
 *
 * 담당:
 * - BrowserWindow 생성 및 관리
 * - IPC 핸들러 등록
 * - Python 브릿지 시작/종료
 * - FFmpeg 설치 여부 사전 확인
 * - 앱 생명주기 관리
 */
import { app, BrowserWindow, Menu, shell, nativeTheme, dialog, ipcMain } from 'electron'
import * as path from 'path'
import * as url from 'url'
import { pythonBridge } from './utils/pythonBridge'
import { licenseService } from './services/LicenseService'
import { settingsService } from './services/SettingsService'
import { checkFFmpeg } from './utils/ffmpegCheck'
import { registerAudioHandlers } from './ipc/audioHandlers'
import { registerFileHandlers } from './ipc/fileHandlers'
import { registerLicenseHandlers } from './ipc/licenseHandlers'
import { registerSettingsHandlers } from './ipc/settingsHandlers'
import { logger } from './utils/logger'

const isDev = process.env.NODE_ENV === 'development'
let mainWindow: BrowserWindow | null = null

// ─────────────────────────────────────────────────────
// 윈도우 생성
// ─────────────────────────────────────────────────────
function createWindow(): void {
  nativeTheme.themeSource = 'dark'

  mainWindow = new BrowserWindow({
    width:  1200,
    height: 800,
    minWidth:  960,
    minHeight: 640,
    backgroundColor: '#0f0f23',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js'),
      devTools: isDev,
    },
    show: false,
    icon: getAppIcon(),
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (isDev) mainWindow?.webContents.openDevTools()
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadURL(url.format({
      pathname: path.join(__dirname, '../renderer/index.html'),
      protocol: 'file:', slashes: true,
    }))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    shell.openExternal(u)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => { mainWindow = null })

  // IPC 핸들러 등록
  registerAudioHandlers(mainWindow)
  registerFileHandlers()
  registerLicenseHandlers()
  registerSettingsHandlers()

  // FFmpeg 상태 IPC (렌더러에서 조회 가능)
  ipcMain.handle('system:ffmpeg-status', () => {
    return checkFFmpeg(
      process.env.FFMPEG_PATH  || 'ffmpeg',
      process.env.FFPROBE_PATH || 'ffprobe',
    )
  })

  logger.info('Main window created')
}

// ─────────────────────────────────────────────────────
// 메뉴
// ─────────────────────────────────────────────────────
function setupMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'AImastering',
      submenu: [
        { role: 'about', label: 'AImastering 정보' },
        { type: 'separator' },
        { label: '설정', accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('navigate', '/settings') },
        { type: 'separator' },
        { role: 'quit', label: '종료' },
      ],
    },
    {
      label: '파일',
      submenu: [
        { label: '파일 열기...', accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:open-file') },
      ],
    },
    {
      label: '보기',
      submenu: [
        { role: 'reload', label: '새로고침' },
        { role: 'toggleDevTools', label: '개발자 도구' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '전체 화면' },
      ],
    },
    {
      label: '도움말',
      submenu: [
        { label: 'FFmpeg 설치 안내',
          click: () => shell.openExternal('https://ffmpeg.org/download.html') },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function getAppIcon(): string | undefined {
  if (process.platform === 'darwin') return path.join(__dirname, '../../assets/icons/icon.icns')
  if (process.platform === 'win32')  return path.join(__dirname, '../../assets/icons/icon.ico')
  return path.join(__dirname, '../../assets/icons/icon.png')
}

// ─────────────────────────────────────────────────────
// 앱 생명주기
// ─────────────────────────────────────────────────────
app.whenReady().then(async () => {
  logger.info(`App starting: v${app.getVersion()} | ${process.platform}`)

  // ── FFmpeg 사전 확인 ──────────────────────────────
  const ffmpegStatus = checkFFmpeg()
  if (!ffmpegStatus.ffmpeg.available) {
    // FFmpeg 없어도 앱은 실행 — UI에서 오류 표시
    logger.warn('FFmpeg not available — audio processing disabled')
  }

  // ── 라이센스 초기화 ───────────────────────────────
  try {
    await licenseService.init()
    logger.info('License service initialized')
  } catch (err) {
    logger.error('License init error:', err)
  }

  // ── Python 브릿지 시작 ────────────────────────────
  try {
    await pythonBridge.start()
    logger.info('Python bridge ready')
  } catch (err) {
    logger.error('Python bridge failed to start:', err)
    // 앱은 계속 실행 — UI에서 엔진 오류 표시
  }

  setupMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  logger.info('All windows closed, shutting down...')
  await pythonBridge.stop().catch(() => {})
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await pythonBridge.stop().catch(() => {})
})

// 보안: 렌더러 내비게이션 차단
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navUrl) => {
    const parsed = new URL(navUrl)
    if (parsed.protocol !== 'file:' && !isDev) event.preventDefault()
  })
})

// 처리되지 않은 예외 로깅 (앱 크래시 방지)
process.on('uncaughtException',   (err)    => logger.error('Uncaught exception:',   err.message))
process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection:', reason))
