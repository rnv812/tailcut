# tailcut

Clip already-buffered video from any site and save it as MP4 or animated WebP.

## Status

Stage 4 of 5 — the re-encoding path is in progress. A crop, `Optimize`, or the
rewrite-head setting re-encodes MP4 through WebCodecs while copying its sound
unchanged. Animated WebP uses the same decoded frames, writes no sound, and runs
in the encoding lane. The codec is chosen for that clip's geometry, and copy jobs
run beside one encoding job in a separate queue lane. The editor reports the
measured pace after a completed encode, and the export settings are live. The
sandbox end-to-end checks are complete. Only the Windows hardware checklist
remains open.

What a tab records is written to disk in
batches of eight megabytes, in sealed pieces the writer never comes back to, and
survives the tab, the browser and an update: the popup lists what was watched,
pins what should stay, deletes with an undo, and opens any of it in the editor
without copying a byte. A settings page holds the four groups of §9.4 —
what to record, what counts as a video, what to keep and how to export. Recording,
detection and history changes reach a running recording without a reload. Export
settings are read when an editor opens.

Under all of it is what the first two stages built: the extension intercepts MSE
segments, keeps a sliding window indexed by media time, and cuts clips out of it.
The default `Original` path still edits the container without re-encoding a frame.

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

Extra sources land in the last stage. See
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
npm run plan:check   # every plan's blocks, code and prose, still match the repository
```

Load `dist/` through `chrome://extensions` with developer mode on.

The integration tests drive a real Chromium with the real extension loaded. They
are split into a working set, a sweep, and four isolated wall-clock measurements.
`e2e:fast` is the working set — the hook, the bridge, triage, the popup and every
path that ends in a saved file, 144 tests in 3.7 minutes. The last full gate ran
all 171 tests in 43 files in 6.2 minutes: 170 passed and the live YouTube leg was
skipped. The reason each file belongs to its project is written next to it in
`playwright.config.ts`.

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

The quiet-tree Task 11 gate measured 24.3 µs, or 1.83 segment copies. Its sealed
8 MiB write took 9.6 ms.

A page tailcut has refused outright — protected media — costs nothing after the
refusal: the registry tells the hook, and the copying stops where it starts
rather than at the far end of a message.

Writing to disk is measured the same way and by the same rule, in
`tests/e2e/history-cost.spec.ts`: a page plays for twenty-five seconds while
handing the extension a hundred and thirty megabytes of material — the rate of a
4K stream, which is what it takes for the eight-mebibyte batch to go down again
and again rather than dribble out on its two-second tail — and the page must lose
nothing by it: no dropped frames, no long tasks on its main thread, and a median
`appendBuffer` under a millisecond. The test asserts the sizes of the pieces on
disk as well as their number, because a measurement that passes over quarter-
megabyte writes says nothing about the write it claims to price. The frame of the
extension is a process of its own and the writing worker another, so none of it
shares a thread with the page; on the development machine the three numbers come
out 0, 0 and a median of 0 ms — a page's own clock cannot resolve a call the
table above prices at 30–45 µs — and they are the same with no writing at all.
