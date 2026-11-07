# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the Louver Mastering AI Python engine.
#
# Build command (run from services/python-audio/ with venv activated):
#   pyinstaller --clean engine.spec
#
# Output: dist/engine  (Mac/Linux)  or  dist/engine.exe  (Windows)
# The build script copies this to apps/desktop/public/bin/ automatically.

from PyInstaller.utils.hooks import collect_all

# Collect binary extensions and data files from soundfile and numpy
# (soundfile ships a native .so/.dylib/.dll that PyInstaller must include)
#
# `collect_all` is deliberately wide — it takes EVERY submodule and EVERY data
# file of the package — and that width is most of what the engine binary used
# to weigh.  Measured by reading the archive out of the built binary:
#
#     numpy test modules in PYZ.pyz                   2.38 MB
#     numpy test .py files carried as data            1.46 MB  (6.16 MB raw)
#     setuptools + pkg_resources + distutils          1.42 MB
#     libcrypto.so.3 + libssl.so.3                    2.20 MB
#     PyInstaller, unittest, multiprocessing, email,
#       http, urllib, ssl, pydoc, pydoc_data          0.96 MB
#
# Nothing in app/ imports any of it.  The tail arrives through
# `numpy.distutils`, which imports setuptools, which imports email + http +
# urllib, which is what puts OpenSSL in an offline audio engine.  The
# `excludes` list below cannot stop that on its own: `collect_all` hands these
# back as explicit hiddenimports, and an explicit hiddenimport is not pruned.
#
# So the collected lists are filtered here, at the source, and `excludes`
# stays as the second line of defence.
DROP_MODULES = (
    'numpy.distutils',
    'numpy.f2py',
    'numpy.testing',
    'numpy.conftest',
    'numpy._pytesttester',
)


def _is_test_module(name):
    return name.endswith('.tests') or '.tests.' in name


def _is_test_data(dest):
    parts = dest.replace('\\', '/').split('/')
    return 'tests' in parts or 'testing' in parts


datas    = []
binaries = []
hiddenimports = []

for pkg in ('soundfile', 'numpy', 'numpy.core', 'numpy.fft'):
    d, b, h = collect_all(pkg)
    datas    += [(src, dest) for src, dest in d if not _is_test_data(dest)]
    binaries += b
    hiddenimports += [
        m for m in h
        if not _is_test_module(m) and not m.startswith(DROP_MODULES)
    ]

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
        # soundfile reaches libsndfile through cffi in ABI mode (`ffi.dlopen`),
        # so `cffi` and its `_cffi_backend` extension are a RUNTIME dependency
        # even though no compiler is involved.  Named here because excluding
        # `distutils` — which cffi's build-time half imports — took the whole
        # cffi graph out of the analysis, and then `import soundfile` raised
        # ImportError inside app/utils/audio_io.py's try block.  The engine
        # went on answering OK with every band at -120 dB.
        'cffi',
        '_cffi_backend',
        # `numpy.random.bit_generator` is a compiled extension and does
        # `from secrets import randbits` from inside it, where no static
        # analysis can see it.  It used to arrive anyway, as a transitive
        # import of setuptools/http/email; with those gone it has to be named,
        # or `import numpy` raises ModuleNotFoundError: No module named
        # 'secrets' — which is how a 27 MB engine with no waveform analysis
        # at all still answered every request with OK.
        'secrets',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', '_tkinter', 'Tkinter',
        'pytest', '_pytest', 'test', 'tests',
        'matplotlib', 'scipy', 'pandas',
        'PIL', 'cv2',
        # Build-time only.  `setuptools` is what drags email/http/urllib and
        # with them OpenSSL into a process that opens no socket; `PyInstaller`
        # is the builder packaging itself into its own output.
        'setuptools', 'pkg_resources', 'distutils', 'PyInstaller',
        'unittest', 'doctest', 'pydoc', 'pydoc_data',
        'multiprocessing', 'email', 'http', 'urllib3',
        'ssl', '_ssl', 'xmlrpc',
        # NOT 'urllib': `pathlib` imports `urllib.parse`, so excluding the
        # package stops the bootloader before READY — measured, the build
        # succeeds and the binary dies in pyi_rth_inspect with
        # `No module named 'urllib'`.  0.08 MB, and it has to stay.
        # A console app that never gets a prompt: readline pulls in ncurses.
        'readline', 'rlcompleter',
        # The engine speaks JSON over a UTF-8 pipe.  These are the legacy
        # multi-byte codecs, ~0.4 MB of tables for encodings nothing selects.
        'encodings.cp932', 'encodings.cp936', 'encodings.cp949',
        'encodings.cp950', 'encodings.euc_jp', 'encodings.euc_jis_2004',
        'encodings.euc_jisx0213', 'encodings.euc_kr', 'encodings.gb2312',
        'encodings.gbk', 'encodings.gb18030', 'encodings.hz',
        'encodings.iso2022_jp', 'encodings.iso2022_jp_1',
        'encodings.iso2022_jp_2', 'encodings.iso2022_jp_2004',
        'encodings.iso2022_jp_3', 'encodings.iso2022_jp_ext',
        'encodings.iso2022_kr', 'encodings.johab',
        'encodings.shift_jis', 'encodings.shift_jis_2004',
        'encodings.shift_jisx0213', 'encodings.big5', 'encodings.big5hkscs',
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
