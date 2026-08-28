# tailcut

Clip already-buffered video from any site and save it as MP4.

## Status

Stage 1 of 5 — capture. The extension intercepts MSE segments, keeps a sliding
window indexed by media time, and saves the buffered material as a single MP4.

An ordinary `<video src>` is recorded as well, and it is the commoner case off
the video platforms: eighteen of twenty-one live pages that delivered any video
at all delivered it that way. Nothing of such a file passes through MSE, so
there is nothing to intercept — what is kept is an index read out of the file
itself by two ranged requests from the extension origin, and a save fetches the
material of the clip in one more. It becomes a session like any other, under the
same merge key, the same triage and the same button, and what is offered is the
stretch that actually passed through the player rather than the whole file.

One page shape in the survey delivered neither of those: coub puts the picture in a `<video src>`
with no audio track in it and the sound in a separate `<audio src>` seven times as long, both
looping, each turning on a cycle of its own. There is no single piece of media on such a page and
no single clock, so a clip has to be defined rather than found. The picture is the clip and states
its length; the soundtrack is laid under it from its start, which is the pairing the page itself
makes when it loads and the only one that can be stated in media time; nothing is ever looped to
fill a gap, and the popup says in as many words that the sound came from a track playing
underneath rather than from the video. Where the pairing cannot be made — the track unreadable,
or two of them playing with nothing to say which belongs to the picture — the clip is silent and
the popup says that instead. Only as much of the track as the picture is long is ever fetched.

Editing, disk history, re-encoding and extra sources land in later stages. See
`docs/superpowers/specs/2026-08-22-tailcut-design.md`.

## Development

```bash
npm install
npm run build        # bundle into dist/
npm run dev          # rebuild on change
npm test             # unit tests (Vitest)
npm run e2e:fast     # the working set: run it after every change
npm run e2e          # the whole sweep: run it once, when a task is finished
npm run typecheck
npm run plan:check   # every plan's code blocks still match the repository
```

Load `dist/` through `chrome://extensions` with developer mode on.

The integration tests drive a real Chromium with the real extension loaded, and
they are split in two by what each one is for rather than by what it costs.
`e2e:fast` is the working set — the hook, the bridge, triage, the popup and
every path that ends in a saved file, sixty tests in about a minute. `e2e` adds
the sweep on top of it: the codec matrix, a minute of watching, the
ordinary-file path with its ranged reads, the pages full of frames, and the
overhead measurement, which runs last and by itself. The reason each file is in
the set it is in is written next to it in `playwright.config.ts`.

Both run headless. `HEADED=1 npm run e2e:fast` puts the windows back.

### Live sites

The offline suite never goes to the network: every test serves the fixtures out of the
repository. `tests/e2e/youtube.spec.ts` runs one set of assertions over a page shaped the way
YouTube delivers — AV1 picture in mp4, Opus sound in WebM, two SourceBuffers — records it, opens
the editor, cuts two seconds out by timecode and reads the file back with ffprobe. That leg runs
by default and needs nothing but the repository.

The same assertions can be pointed at the real thing, and that leg is kept out of the default run:

```bash
TAILCUT_LIVE=1 npx playwright test youtube
```

It watches a real YouTube page for twenty-five seconds and then does exactly what the offline leg
does. An automated browser with an empty profile gets a short buffer — on the order of twenty
seconds — so it proves the road and not the depth: a real DASH init with an edit list of its own,
whatever codec the day serves, and a real page title in the file name.

A failure there is a reason to look, not a reason to hold a release: the page belongs to somebody
else and changes more often than the test does. A failure in the offline leg is ours.

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

A page tailcut has refused outright — protected media — costs nothing after the
refusal: the registry tells the hook, and the copying stops where it starts
rather than at the far end of a message.
