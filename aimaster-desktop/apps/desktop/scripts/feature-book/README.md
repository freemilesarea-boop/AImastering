# 기능북 — LV DAW feature book

Three steps, in this order, and the middle one needs the dev app running.

```bash
pnpm -s dev                                  # or scripts/app-smoke/boot.sh
npx tsx scripts/feature-book/inventory.ts  <dir>/inventory.json
node   scripts/feature-book/capture.mjs    <dir> [cdp-port]
node   scripts/feature-book/build.mjs      <dir>
```

**Nothing in the book is typed by hand.** The screens are photographs of the
running app, the controls are read out of that app's own DOM with their
tooltips, and the commands, effects, instruments and templates come from the
very modules the app imports. A feature book written any other way is correct
on the day it is written and quietly wrong a week later.

## What each step learned the hard way

`capture.mjs` **verifies every navigation before it photographs anything.**
`setPage` can decline — it refuses `result` until the window has seen a real
pointerdown or keydown — and the store's field is `currentPage`, not `page`.
Without the read-back the script photographed the DAW and captioned it 결과,
then did the same thing twice more. A capture that does not check what it
captured produces a beautiful book about the wrong screens.

The mastering screen is **not a screen you browse**: entering it with a file
selected starts a real run and shows that run's progress, and with no file it
sends you home. So the book lets the app do the work and follows it to the
result screen, which it routes to by itself.

`build.mjs` prints the PDF **twice**: once to find out which page each part
landed on, then again with those numbers in the contents. A hundred-page
reference whose contents cannot say where anything is is a hundred pages of
scrolling.

## What it needs

- A Korean font. `fonts-noto-cjk` — without it every Hangul glyph is a box.
- `playwright-core` and the Chromium at `/opt/pw-browsers/chromium`.
- `poppler-utils` (`pdftotext`) for the contents' page numbers.
