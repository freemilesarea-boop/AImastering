/**
 * Electron 메인 프로세스 진입점
 *
 * 담당:
 * - BrowserWindow 생성 및 관리
 * - IPC 핸들러 등록
 * - Python 브릿지 시작/종료
 * - 앱 생명주기 관리
 */
import { app, BrowserWindow, Menu, shell, nativeTheme } from 'electron'
import * as path from 'path'
import * as url from 'url'
import { pythonBridge } from './utils/pythonBridge'
import { licenseService } from './services/LicenseService'
import { settingsService } from './services/SettingsService'
import { registerAudioHandlers } from './ipc/audioHandlers'
import { registerFileHandlers } from './ipc/fileHandlers'
import { registerLicenseHandlers } from './ipc/licenseHandlers'
import { registerSettingsHandlers } from './ipc/settingsHandlers'
import { logger } from './utils/logger'

// ─────────────────────────────────────────
// 개발 환경 설정
// ─────────────────────────────────────────
const isDev = process.env.NODE_ENV === 'development'

let mainWindow: BrowserWindow | null = null

// ─────────────────────────────────────────
// 메인 윈도우 생성
// ─────────────────────────────────────────
function createWindow(): void {
  // 다크 테마 강제 적용
  nativeTheme.themeSource = 'dark'

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f23',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    webPreferences: {
      nodeIntegration: false,           // 보안: Node.js 직접 접근 비활성화
      contextIsolation: true,           // 보안: 컨텍스트 격리 활성화
      preload: path.join(__dirname, '../preload/index.js'),
      devTools: isDev,
    },
    show: false, // 렌더링 완료 후 표시
    icon: getAppIcon(),
  })

  // 렌더링 완료 후 윈도우 표시 (화면 깜빡임 방지)
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (isDev) mainWindow?.webContents.openDevTools()
  })

  // 페이지 로드
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadURL(
      url.format({
        pathname: path.join(__dirname, '../renderer/index.html'),
        protocol: 'file:',
        slashes: true,
      })
    )
  }

  // 외부 링크는 브라우저에서 열기
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // IPC 핸들러 등록
  registerAudioHandlers(mainWindow)
  registerFileHandlers()
  registerLicenseHandlers()
  registerSettingsHandlers()

  logger.info('Main window created')
}

// ─────────────────────────────────────────
// 앱 메뉴 설정
// ─────────────────────────────────────────
function setupMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'AImastering',
      submenu: [
        { role: 'about', label: 'AImastering 정보' },
        { type: 'separator' },
        { label: '설정', accelerator: 'CmdOrCtrl+,', click: () => mainWindow?.webContents.send('navigate', '/settings') },
        { type: 'separator' },
        { role: 'quit', label: '종료' },
      ],
    },
    {
      label: '파일',
      submenu: [
        { label: '파일 열기...', accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send('menu:open-file') },
        { label: '최근 파일', role: 'recentDocuments' as Electron.MenuItemConstructorOptions['role'] },
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' },
        { role: 'redo', label: '다시 실행' },
        { type: 'separator' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
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
        { label: '공식 웹사이트', click: () => shell.openExternal('https://aimastering.app') },
        { label: '업데이트 확인...', click: () => mainWindow?.webContents.send('check-update') },
      ],
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

// ─────────────────────────────────────────
// 앱 아이콘
// ─────────────────────────────────────────
function getAppIcon(): string | undefined {
  if (process.platform === 'darwin') {
    return path.join(__dirname, '../../assets/icons/icon.icns')
  }
  if (process.platform === 'win32') {
    return path.join(__dirname, '../../assets/icons/icon.ico')
  }
  return path.join(__dirname, '../../assets/icons/icon.png')
}

// ─────────────────────────────────────────
// 앱 생명주기
// ─────────────────────────────────────────

app.whenReady().then(async () => {
  logger.info(`App starting: version=${app.getVersion()} platform=${process.platform}`)

  try {
    // 라이센스 서비스 초기화
    await licenseService.init()
    logger.info('License service initialized')

    // Python 브릿지 시작
    await pythonBridge.start()
    logger.info('Python bridge started')
  } catch (err) {
    logger.error('Startup error:', err)
    // Python 브릿지 실패해도 앱은 계속 실행 (분석/처리만 불가)
    // UI에서 오류 상태를 표시함
  }

  setupMenu()
  createWindow()

  // macOS: Dock 아이콘 클릭 시 윈도우 재활성화
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  logger.info('All windows closed, shutting down...')
  await pythonBridge.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await pythonBridge.stop()
})

// 보안: 새 윈도우 생성 차단
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsed = new URL(navigationUrl)
    if (parsed.protocol !== 'file:' && !isDev) {
      event.preventDefault()
    }
  })
})

// 처리되지 않은 예외 로깅 (앱 크래시 방지)
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.message)
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason)
})
