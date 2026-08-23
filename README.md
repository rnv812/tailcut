# tailcut

Clip already-buffered video from any site and save it as MP4.

## Status

Stage 1 of 5 — capture. The extension intercepts MSE segments, keeps a sliding
window indexed by media time, and saves the buffered material as a single MP4.

Editing, disk history, re-encoding and extra sources land in later stages. See
`docs/superpowers/specs/2026-08-22-tailcut-design.md`.

## Development

```bash
npm install
npm run build        # bundle into dist/
npm run dev          # rebuild on change
npm test             # unit tests (Vitest)
npm run e2e          # integration tests (Playwright, real Chromium)
npm run typecheck
npm run plan:check   # plan code blocks still match the repository
```

Load `dist/` through `chrome://extensions` with developer mode on.

Test fixtures are generated once with `tools/make-fixtures.sh` and committed;
ffmpeg is only needed to regenerate them. `ffprobe`, shipped with ffmpeg, is
required by `npm test`: one check plays the assembled MP4 through it.

## Performance baseline

The extension must not get in a site's way, and that promise is worth only what
it is measured at. `tests/e2e/overhead.spec.ts` loads the same page in the same
Chromium twice — once with the extension, once without — and sums the time spent
inside `appendBuffer` across 300 appends of roughly 77 KB each.

The wrapper is allowed to cost one copy of the segment and a queued microtask,
so the budget is stated in copies of that segment, measured on the same machine
in the same page. A ratio, not a millisecond count: a slower machine moves both
numbers together. The test fails above four copies.

On the development machine (Chromium 151, WSL2), over twenty-five runs:

| | per `appendBuffer` call |
|---|---|
| without the extension | 2.3–5.3 µs |
| with the extension | 29.7–45.3 µs |
| the difference | 26.3–42.0 µs, i.e. 1.45–2.52 copies |

Both numbers are printed on every run, so run it to see where your machine
stands. A number outside that band is not automatically a regression — it is an
invitation to look at what changed on the synchronous path.
