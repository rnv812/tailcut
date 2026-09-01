<p align="center">
  <img src="assets/tailcut/promo/readme-banner-1280x440.png" alt="tailcut product overview" width="100%">
</p>

<p align="center">
  <a href="https://github.com/rnv812/tailcut/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/rnv812/tailcut/actions/workflows/ci.yml/badge.svg"></a>
  <a href="#current-limits"><img alt="Pre-release status" src="https://img.shields.io/badge/status-pre--release-B7F03F?style=flat-square&labelColor=17181F"></a>
  <a href="#install"><img alt="Chrome 120+" src="https://img.shields.io/badge/Chrome%20%2F%20Chromium-120%2B-F6F5F8?style=flat-square&logo=googlechrome&logoColor=B7F03F&labelColor=17181F"></a>
  <a href="manifest.json"><img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-F6F5F8?style=flat-square&labelColor=17181F"></a>
  <a href="PRIVACY.md"><img alt="Local-only data" src="https://img.shields.io/badge/data-local%20only-F6F5F8?style=flat-square&labelColor=17181F"></a>
  <a href="#development-and-verification"><img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-F6F5F8?style=flat-square&logo=typescript&logoColor=B7F03F&labelColor=17181F"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-B7F03F?style=flat-square&labelColor=17181F"></a>
</p>

<p align="center">
  <a href="#highlights">Highlights</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#editor-and-export">Editor</a> ·
  <a href="#privacy-and-storage">Privacy</a> ·
  <a href="#install">Install</a>
</p>

<p align="center">
  <strong>Turn buffered web video into precise, local clips.</strong><br>
  Watch normally. Save the part that already happened.
</p>

tailcut is a Chrome extension for turning video that has already passed through a web player into a file. Open the extension after the moment, save the available material immediately, or shape it into frame-accurate clips in the editor.

It is not a screen recorder and it does not start a second download of a streaming video. tailcut captures the media data the player receives during the viewing session, indexes it by media time, and writes a new container around the selected samples. The default **Original** path does not re-encode the picture.

> [!NOTE]
> **Pre-release, version `0.1.0`.** The supported installation path is currently an unpacked Chrome/Chromium extension built from this repository.

## Highlights

<table>
  <tr>
    <td width="33%"><strong>Clip after the moment</strong><br><br>The rolling window keeps the latest three minutes of active playback by default, adjustable from 15 seconds to 30 minutes.</td>
    <td width="33%"><strong>Original means original</strong><br><br>The normal MP4 path copies compressed samples and rebuilds the container. It does not decode and re-encode every frame.</td>
    <td width="33%"><strong>Frame-accurate editor</strong><br><br>Step by frame, type timecodes, split, mark, snap, zoom, inspect waveforms and preview frames under the pointer.</td>
  </tr>
  <tr>
    <td width="33%"><strong>Built for web players</strong><br><br>Captures MediaSource, worker-owned MediaSource and ordinary <code>&lt;video src&gt;</code> media without hostname-specific integrations.</td>
    <td width="33%"><strong>Local, durable history</strong><br><br>Recordings can survive tab and browser restarts in extension-owned storage, with pinning, retention, disk limits and undoable deletion.</td>
    <td width="33%"><strong>Measured page impact</strong><br><br>Parsing and storage stay off the player's synchronous path. Browser tests enforce a fixed overhead budget.</td>
  </tr>
</table>

Crop and optimize only when needed. Free crop and 16:9, 9:16, 1:1 and 4:5 frames are available per clip. MP4 re-encoding uses WebCodecs; animated WebP uses the browser's canvas encoder.

## Editor preview

<p align="center">
  <img src="assets/tailcut/demo.png" alt="tailcut editor with video preview, clip settings, transport controls, waveform and timeline" width="100%">
</p>

## How it works

1. **Watch a video normally.** Recording is enabled on all sites by default. The default detector qualifies a visible player after six seconds of active playback.
2. **Open tailcut from the extension icon.** The popup lists recordings from the current page and recent history. Opening it freezes a snapshot for the action while capture can continue behind it.
3. Choose **Save all** for the fastest path, or **Edit** to open the snapshot in a separate extension tab.
4. In the editor, set In and Out points, create as many clips as needed, adjust sound, crop, format and export mode per clip, then send them to the export queue.

The rolling buffer is indexed by presentation timestamp rather than arrival order. Seeking backward fills the matching point in the timeline, rewatching does not duplicate time, and seeking forward records an explicit gap instead of pretending missing media exists.

## Capture and format support

tailcut targets **Chrome and Chromium 120 or newer** through Manifest V3.

| Input path | Current behavior |
|---|---|
| MediaSource with fragmented MP4 | Captures appended initialization and media segments. The Original path preserves the source picture codec. |
| MediaSource with WebM | Supports VP8 or VP9 picture and Opus or Vorbis sound, converting their track descriptions into MP4 for export. |
| MediaSource created inside a worker | Wraps the worker without moving parsing or storage onto the page's synchronous path. |
| Ordinary `<video src>` media | Reads the file index with bounded range requests and offers only the interval the player holds, not the whole file behind the URL. |
| Separate looping picture and soundtrack | Can pair a silent video with one unambiguous audio element playing beside it, without looping audio to manufacture missing material. |

Multiple players on one page remain separate sessions. Feeds, embedded frames, quality variants and alternate tracks are recorded as distinct material rather than flattened into one arrival-order buffer.

## Editor and export

The editor is a full extension page, isolated from the website's CSS, content security policy and fullscreen behavior. Its timeline is derived from the captured sample tables rather than estimated from wall-clock playback.

Each clip has its own:

- name, In point and Out point;
- MP4 or animated WebP format;
- **Original** or **Optimize** picture mode;
- sound switch;
- crop frame and output geometry.

**Original** is the normal MP4 path. It writes a progressive MP4, preserves compressed picture and sound packets, and physically drops samples beyond the selected end. An edit list provides a precise start without rewriting the picture. The optional rewrite-start setting trades that copy-only start for re-encoding when compatibility with edit lists matters.

**Optimize** and crop exports decode the selected picture and choose an encoder at runtime for that clip's geometry and frame rate. The ladder can use hardware HEVC, hardware H.264 or software H.264 according to browser support. Audio packets are copied unchanged, never transcoded. Animated WebP is silent by definition and is intended for a self-looping image, not as a smaller substitute for MP4.

Copy jobs can run beside one encoding job in a separate queue lane. Jobs expose progress, cancellation, retry and the measured encoding pace after a completed run.

## Architecture

Binary media follows this path:

```mermaid
flowchart LR
    player["Web player<br>MAIN world"] -->|transferable buffers| bridge["Extension bridge"]
    bridge --> writer["Writer worker"]
    writer --> opfs[("Local OPFS history")]
    opfs --> editor["Frame-accurate editor"]
    editor --> output["MP4 or animated WebP"]
```

| Context | Responsibility |
|---|---|
| Page hook | Observes the real MediaSource, copies an appended buffer, queues it and returns to the player. |
| Isolated content script | Discovers video elements, follows playback and visibility, applies recording rules and reports player dimensions. |
| Extension bridge | Receives transferable binary data and owns page-session storage without JSON serialization. |
| Service worker | Coordinates live sessions, domain rules, badges, retention and storage cleanup. |
| Popup | Starts every user action: pause or resume, direct save, edit, history, pin and delete. |
| Editor | Builds previews, timelines, clips and exports in a separate extension tab. |
| Options page | Owns recording, detection, history and export settings. |

The data-only implementation under [`src/core/`](src/core/) has no dependency on the DOM, `chrome.*` or WebCodecs. Container parsing, timeline arithmetic, clip planning, muxing, crop calculations, codec selection and queue behavior can therefore run in ordinary unit tests.

## Privacy and storage

tailcut has no account, analytics, telemetry or remote backend. Settings use `chrome.storage.local`; the history index uses IndexedDB; recorded pieces and editor snapshots use the Origin Private File System on the extension origin. Finished clips go to the user's Downloads folder. See the full [Privacy Policy](PRIVACY.md).

The application code originates one kind of network request: a bounded byte-range request to the media URL that the page is already playing, used to read ordinary `<video src>` files. The browser may attach the credentials it already has for that host, but tailcut does not read or retain them. It does not read cookies or store passwords or tokens.

The broad `<all_urls>` host permission is required for two product behaviors: observing players across sites and making cross-origin range reads to the media CDN already serving the page. Recording can be changed to an allowlist or turned off globally, and any site or current tab can be paused from the popup.

Defaults:

| Setting | Default | Range or behavior |
|---|---:|---|
| Rolling buffer | 180 seconds | 15–1800 seconds |
| Recording mode | All sites | All sites, allowlist or off, plus a denylist |
| Video detection | Balanced | 6 seconds of playback, minimum 320 px width |
| Save history to disk | On | Can be disabled without deleting existing history |
| Retention | 7 days | 1–90 days |
| Disk ceiling | 4 GiB | 256 MiB–64 GiB; pinned recordings are protected from normal eviction |
| Export | Original MP4 | High quality, automatic codec choice if re-encoding is required |

Deletion is undoable for 30 seconds. Storage cleanup is centralized in the service worker so the popup, editor and page do not race to decide which files still belong to a recording.

## Performance baseline

The page hook does no container parsing. Its synchronous work is limited to copying the appended bytes and scheduling their transfer. [`tests/e2e/overhead.spec.ts`](tests/e2e/overhead.spec.ts) compares the same page in the same Chromium with and without the extension and fails if the added cost exceeds four copies of the segment.

Last recorded baseline on Chromium 151 under WSL2, across 25 runs of 300 appends at roughly 77 KB each:

| Measurement | Per `appendBuffer` call |
|---|---:|
| Without tailcut | 2.3–5.3 µs |
| With tailcut | 29.7–45.3 µs |
| Added cost | 26.3–42.0 µs, or 1.45–2.52 segment copies |

The quiet-tree completion gate measured 24.3 µs, or 1.83 segment copies. A sealed 8 MiB storage write took 9.6 ms. Under a 130 MB / 25 s recording load, the page-side test observed zero dropped frames, zero long tasks and a 0 ms median `appendBuffer` duration at the page clock's resolution.

These values describe one machine and browser build. The ratio and enforced budget are the regression signal; raw microseconds will vary by system.

## Install

### Tagged release builds

Tagged builds appear on [GitHub Releases](https://github.com/rnv812/tailcut/releases) only after the tagged commit passes the complete verification gate. When a build is available:

1. Download `tailcut-v…-chrome.zip` from the version you want.
2. Extract the ZIP. It contains one ready-to-load `tailcut-v…-chrome` directory.
3. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select that extracted directory.
4. Pin tailcut to the toolbar.

Chrome loads unpacked extensions from a directory, not directly from a ZIP. The adjacent `.sha256` file lets you verify the downloaded archive before extracting it. Until a tagged build appears on the Releases page, use the source build below.

### Build from source

Prerequisites:

- Chrome or a Chromium-based browser at version 120 or newer;
- Node.js and npm;
- `ffprobe` from FFmpeg if you plan to run the test suite.

```bash
git clone https://github.com/rnv812/tailcut.git
cd tailcut
npm ci
npm run build
```

Then open `chrome://extensions`:

1. Enable **Developer mode**.
2. Choose **Load unpacked**.
3. Select the generated `dist/` directory.
4. Pin tailcut to the toolbar.

Rebuild after source changes. Chrome may require the unpacked extension to be reloaded from `chrome://extensions` before a changed manifest or background worker takes effect.

## Development and verification

```bash
npm run dev          # rebuild dist/ when a source file changes
npm run build        # produce the unpacked extension in dist/
npm run typecheck    # TypeScript, strict + noUncheckedIndexedAccess
npm test             # Vitest unit and integration tests; requires ffprobe
npm run e2e:fast     # main Playwright set with the real extension loaded
npm run e2e          # complete browser suite, including isolated measurements
```

Install Playwright's browser before the first end-to-end run if it is not already present:

```bash
npx playwright install chromium
```

The latest recorded full gate ran 171 browser tests in 43 files: 170 passed and the opt-in live-site leg was skipped. The working set ran 144 tests: 143 passed and the same live leg was skipped. Offline browser tests serve committed fixtures and do not depend on third-party websites.

To run the live YouTube compatibility leg explicitly:

```bash
TAILCUT_LIVE=1 npx playwright test youtube
```

A live-site failure is diagnostic rather than a release gate because the page and its delivery choices are controlled by a third party. Fixture-backed failures remain project failures.

## Current limits

| Boundary | What it means |
|---|---|
| Protected media | DRM content is refused. tailcut does not decrypt media or interact with CDM keys. |
| Not a general downloader | Ordinary files are limited to media held by the player; a reachable URL does not authorize a whole-file download. |
| MPEG-TS | Direct MPEG-TS ingestion is not implemented. Surveyed HLS players remuxed it before MediaSource. |
| Output formats | MP4 and silent animated WebP only. There is no GIF output. |
| Browser support | Chrome and Chromium only. Firefox needs a different page-injection compatibility layer. |
| Global hotkeys | Actions begin at the extension icon. The editor has its own keyboard controls. |
| Renditions and tracks | One output file uses one continuous rendition and one track of each kind. Gaps and incompatible changes are reported instead of silently combined. |
| WebM ingest | VP8/VP9 with Opus/Vorbis is supported. MediaSource WebM requires one track per SourceBuffer; AV1-in-WebM is refused. |
| Hardware encoding | HEVC/H.264 support depends on the browser, system, driver and clip geometry. tailcut probes every clip and can fall back to software H.264. |
| Crash window | A recent storage batch can be lost in a crash. Batches close at 8 MiB or after two seconds to protect page performance. |

## Feature reference

<details>
<summary><strong>Capture controls</strong></summary>


- Global modes: all sites, allowlist or off.
- Denylist that overrides normal recording.
- Per-site enable/disable and per-tab pause/resume from the popup.
- Adjustable 15-second to 30-minute rolling window.
- Loose, balanced and strict video-detection presets, plus custom probation, minimum width and muted-video rules.
- Separate sessions for multiple players, embeds, feeds, SourceBuffers and representations.
- Protection, unsupported-track, unreadable-file, gap, rendition, alternate-track and separate-sound explanations in the popup.

</details>

<details>
<summary><strong>History</strong></summary>


- Disk-backed recordings survive tab closure, browser restarts and extension updates.
- Recent recordings show title, host, duration, age and disk use.
- Pinning protects a recording from retention and size-based eviction.
- Per-recording deletion with undo instead of a confirmation dialog.
- Optional memory-only mode for sessions that should disappear with the tab.
- Retention and disk ceilings applied by value so useful, recent recordings are kept ahead of low-value material.

</details>

<details>
<summary><strong>Editor</strong></summary>


- Frame stepping, play/pause and J-K-L shuttle at 1×, 2×, 4×, 8× and 16×.
- Frame-aware playhead plus directly editable In, Out and playhead timecodes.
- Multiple overlapping clips from one recording, with split and removal actions.
- Zoom around the playhead, fit selection, fit recording and horizontal pan.
- Snapping to frame, clip, marker and recording boundaries.
- Audio waveform, source lanes, gaps, clip bands, markers and hover-frame previews.
- Undo and redo for editing actions.
- Picture-representation selection when a recording contains more than one.
- Free crop plus 16:9, 9:16, 1:1 and 4:5 presets, reset and apply-to-all.

Press `?` in the editor for the complete keyboard map.

</details>

<details>
<summary><strong>Export</strong></summary>


- Direct **Save all** from the popup or multi-clip export from the editor.
- Progressive MP4 output with physical tail trimming and gap-aware timestamps.
- Original sample-copy path with no picture re-encoding.
- Optional picture optimization through hardware HEVC, hardware H.264 or software H.264.
- High, medium and low re-encoding quality levels.
- Sound included or removed per MP4 clip; sound packets are copied unchanged when included.
- Silent animated WebP output with preserved frame timing and looping metadata.
- Per-clip crop, geometry, format, mode and name.
- File-name templates using `{title}`, `{in}`, `{out}`, `{date}` and `{host}`.
- Optional save-location prompt for every clip.
- Separate copy and encoding queue lanes with progress, cancellation and retry.

</details>

## License

tailcut is available under the [MIT License](LICENSE).
