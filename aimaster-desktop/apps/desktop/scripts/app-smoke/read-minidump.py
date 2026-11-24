#!/usr/bin/env python3
"""read-minidump.py — say which module a crash happened in.

    python3 scripts/app-smoke/read-minidump.py <dump.dmp> [...]

A minidump is the only thing a native crash leaves behind, and the one
question worth asking it is "what code was running".  A full stack walk needs
symbols nobody here has; the faulting ADDRESS and the module it lands inside
need neither, and that is already the difference between "the renderer
crashed" and "the renderer crashed inside ffmpeg.dll".

Reads only the two streams that answer it — the exception record and the
module list — straight out of the file format.  No dependencies, because the
machine that has the dump is usually not the machine with the toolchain.
"""
import struct
import sys

MINIDUMP_SIGNATURE = b'MDMP'
STREAM_MODULE_LIST = 4
STREAM_EXCEPTION = 6
STREAM_SYSTEM_INFO = 7

# The few exception codes worth naming on sight.
CODES = {
    0xC0000005: 'ACCESS_VIOLATION — read or wrote memory it does not own',
    0xC00000FD: 'STACK_OVERFLOW',
    0xC000001D: 'ILLEGAL_INSTRUCTION',
    0xC0000094: 'INTEGER_DIVIDE_BY_ZERO',
    0xC0000374: 'HEAP_CORRUPTION',
    0x80000003: 'BREAKPOINT — a debug break, often an assertion',
    0xE0000008: 'OUT_OF_MEMORY (Chromium)',
}
ARCH = {0: 'x86', 5: 'arm', 6: 'ia64', 9: 'x86_64', 12: 'arm64'}

# On Linux and macOS the "exception code" is the signal that killed it, which
# is a small number and means something else entirely.  Reading 0x0B as an
# NTSTATUS would have printed "(unlisted)" and said nothing; it is SIGSEGV.
SIGNALS = {
    4: 'SIGILL — illegal instruction',
    6: 'SIGABRT — abort(), usually a failed assertion',
    7: 'SIGBUS — bad memory access alignment or a mapping that vanished',
    8: 'SIGFPE — arithmetic fault',
    9: 'SIGKILL — killed from outside; not a fault',
    11: 'SIGSEGV — read or wrote memory it does not own',
}


def describe(code):
    """What this code means, given that the two platforms number differently."""
    if code in CODES:
        return f'{CODES[code]}  (Windows)'
    if code in SIGNALS:
        return f'{SIGNALS[code]}  (POSIX signal {code})'
    if code > 0xFFFF:
        return '(an NTSTATUS this reader does not list)'
    return '(a signal this reader does not list)'


def streams(buf):
    sig, version, count, rva = struct.unpack_from('<4sIII', buf, 0)
    if sig != MINIDUMP_SIGNATURE:
        raise SystemExit(f'not a minidump: starts with {sig!r}')
    del version
    out = {}
    for i in range(count):
        kind, size, loc = struct.unpack_from('<III', buf, rva + i * 12)
        out.setdefault(kind, (size, loc))
    return out


def utf16(buf, rva):
    """A MINIDUMP_STRING: a 32-bit byte length then UTF-16."""
    if rva == 0 or rva + 4 > len(buf):
        return ''
    (length,) = struct.unpack_from('<I', buf, rva)
    raw = buf[rva + 4: rva + 4 + length]
    return raw.decode('utf-16-le', errors='replace')


def modules(buf, where):
    size, rva = where
    del size
    (count,) = struct.unpack_from('<I', buf, rva)
    out = []
    at = rva + 4
    for _ in range(count):
        base, msize, _checksum, _stamp, name_rva = struct.unpack_from('<QIIII', buf, at)
        out.append((base, msize, utf16(buf, name_rva)))
        at += 108  # sizeof(MINIDUMP_MODULE)
    return out


def exception(buf, where):
    size, rva = where
    del size
    thread_id, _align = struct.unpack_from('<II', buf, rva)
    code, flags, _record, address = struct.unpack_from('<IIQQ', buf, rva + 8)
    return thread_id, code, flags, address


def system(buf, where):
    if where is None:
        return None
    _size, rva = where
    arch, _lvl, _major, _minor = struct.unpack_from('<HHBB', buf, rva)
    return ARCH.get(arch, f'arch {arch}')


def report(path):
    with open(path, 'rb') as fh:
        buf = fh.read()
    found = streams(buf)
    print(f'\n{path}  ({len(buf) / 1024:.0f} KB)')

    arch = system(buf, found.get(STREAM_SYSTEM_INFO))
    if arch:
        print(f'  machine   {arch}')

    if STREAM_EXCEPTION not in found:
        print('  no exception stream — this dump was not written by a crash')
        return
    thread_id, code, flags, address = exception(buf, found[STREAM_EXCEPTION])
    print(f'  thread    {thread_id}')
    print(f'  code      0x{code:08X}  {describe(code)}')
    print(f'  flags     0x{flags:08X}')
    print(f'  address   0x{address:016X}')

    if STREAM_MODULE_LIST not in found:
        print('  no module list — cannot say which code that address is in')
        return
    mods = modules(buf, found[STREAM_MODULE_LIST])
    hit = [m for m in mods if m[0] <= address < m[0] + m[1]]
    if hit:
        base, msize, name = hit[0]
        print(f'  IN        {name}')
        print(f'            +0x{address - base:X} of 0x{msize:X}')
    else:
        print('  IN        no loaded module covers that address')
        print('            (JIT-compiled code, a freed library, or a wild pointer)')
    near = sorted(mods, key=lambda m: abs(m[0] - address))[:3]
    print(f'  {len(mods)} modules loaded; nearest by base address:')
    for base, msize, name in near:
        print(f'            {name}  base 0x{base:X} size 0x{msize:X}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for p in sys.argv[1:]:
        report(p)
