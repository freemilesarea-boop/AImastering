# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the Louver Mastering AI Python engine.
#
# Build command (run from services/python-audio/ with venv activated):
#   pyinstaller --clean engine.spec
#
# Output: dist/engine  (Mac/Linux)  or  dist/engine.exe  (Windows)
# The build script copies this to apps/desktop/public/bin/ automatically.

from PyInstaller.utils.hooks import collect_all, collect_data_files

# Collect binary extensions and data files from soundfile and numpy
# (soundfile ships a native .so/.dylib/.dll that PyInstaller must include)
datas    = []
binaries = []
hiddenimports = []

for pkg in ('soundfile', 'numpy', 'numpy.core', 'numpy.fft'):
    d, b, h = collect_all(pkg)
    datas    += d
    binaries += b
    hiddenimports += h

a = Analysis(
    ['app/main.py'],
    pathex=['.'],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports + [
        'soundfile',
        'numpy',
        'numpy.fft',
        'numpy.linalg',
        'numpy.random',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', '_tkinter', 'Tkinter',
        'pytest', '_pytest', 'test', 'tests',
        'matplotlib', 'scipy', 'pandas',
        'PIL', 'cv2',
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='engine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX can break soundfile native libs — keep off
    console=True,       # stdin/stdout JSON-RPC — must be console mode
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,   # use host arch; override with --target-arch for universal2
    codesign_identity=None,
    entitlements_file=None,
)
