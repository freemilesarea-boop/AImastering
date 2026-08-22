#!/usr/bin/env python3
"""Open an AAF this app wrote with an INDEPENDENT implementation.

The TypeScript suite proves the writer and the reader agree with each other
and that the reader handles a real third-party file.  It cannot prove that
somebody else's software accepts what we WRITE — for that you need somebody
else's software.

    pip install pyaaf2
    pnpm --filter @aimaster/desktop exec tsx scripts/aaf-write-sample.ts /tmp/out.aaf
    python3 scripts/aaf-interop-check.py /tmp/out.aaf

Not part of `pnpm test`: it needs Python and pyaaf2, which a machine building
the app is not required to have.  It is here so the interoperability claim can
be re-checked rather than believed.
"""
import sys

try:
    import aaf2
except ImportError:
    sys.exit("pyaaf2 is not installed — `pip install pyaaf2`")

if len(sys.argv) < 2:
    sys.exit("usage: aaf-interop-check.py <file.aaf>")

problems = []
with aaf2.open(sys.argv[1], "r") as f:
    mobs = list(f.content.mobs)
    comps = [m for m in mobs if type(m).__name__ == "CompositionMob"]
    print("mobs: %d (%d composition)" % (len(mobs), len(comps)))
    if not comps:
        problems.append("no CompositionMob — a reader would open an empty timeline")

    for comp in comps:
        print("composition: %r" % comp.name)
        for slot in comp.slots:
            seg = slot.segment
            comps_in = list(seg.components) if hasattr(seg, "components") else [seg]
            print("  slot %s %r  %s  rate=%s  components=%d"
                  % (slot.slot_id, slot.name, type(seg).__name__,
                     getattr(slot, "edit_rate", None), len(comps_in)))
            position = 0
            for c in comps_in:
                kind = type(c).__name__
                if kind == "SourceClip":
                    try:
                        target = c.mob.name if c.mob else None
                    except Exception as err:                      # noqa: BLE001
                        target = None
                        problems.append("a SourceClip does not resolve: %s" % err)
                    urls = []
                    try:
                        d = c.mob.slots[0].segment.mob.descriptor
                        urls = [loc["URLString"].value for loc in d["Locator"].value]
                    except Exception:                             # noqa: BLE001
                        pass
                    print("    %8d  %-10s len=%-8s start=%-8s -> %s %s"
                          % (position, kind, c.length, c.start, target, urls))
                    if not urls:
                        problems.append("clip %r has no media locator" % target)
                else:
                    print("    %8d  %-10s len=%s" % (position, kind, c.length))
                position += c.length or 0

print()
if problems:
    print("PROBLEMS:")
    for p in problems:
        print(" -", p)
    sys.exit(1)
print("the independent reader accepted this file")
