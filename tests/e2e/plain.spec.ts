import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { launchWithExtension, openPopupOn, playInBrowser, probeFile, saveAll, decodeFile } from './helpers'
import { serveMedia, servePage, type Host } from './server'

/**
 * How long the file is played before the popup is opened.
 *
 * Past the six seconds triage gives a player to prove itself, and well short of the twenty the
 * file lasts: what is being watched here is a piece of it, which is the case the whole design
 * turns on — the popup may promise the piece that passed through the player and no more.
 */
const WATCH_MS = 8_000

/** Long enough for the verdict, the two ranged reads and the session to arrive. */
const SETTLE_MS = 1_500

interface Watched {
  context: BrowserContext
  page: Page
  popup: Page
  media: Host
  state: { currentTime: number; duration: number; buffered: Array<[number, number]> }
}

/** Opens a page with an ordinary file on it, watches part of it, and opens the popup over it. */
async function watchPartway(file: string): Promise<Watched> {
  const media = await serveMedia()
  const site = await servePage('plain.html', media.origin, file)
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  // `commit` and not the load event: a <video src> holds the load event open until it has enough
  // of the file, so waiting for it would mean waiting out the very download this test slows down.
  await page.goto(site.origin)
  await page.evaluate(() => (window as unknown as { tcPlay: () => Promise<void> }).tcPlay())
  await page.waitForTimeout(WATCH_MS)
  await page.evaluate(() => (window as unknown as { tcPause: () => void }).tcPause())

  await page.waitForTimeout(SETTLE_MS)

  const state = await page.evaluate(() =>
    (window as unknown as { tcState: () => Watched['state'] }).tcState(),
  )

  const popup = await openPopupOn(context, page, extensionId)
  await site.close()

  return { context, page, popup, media, state }
}

/** The length and the weight the popup is showing, read off the page it draws. */
async function promised(popup: Page): Promise<{ text: string; seconds: number }> {
  const text = await popup.getByTestId('duration').textContent()
  const [minutes, seconds] = (text ?? '0:00').split(':').map(Number)
  return { text: text ?? '', seconds: (minutes ?? 0) * 60 + (seconds ?? 0) }
}

/** Ranged reads with both ends stated: the extension's, as against the element's open-ended ones. */
const boundedReads = (host: Host): string[] =>
  host.asked.filter((range): range is string => /^bytes=\d+-\d+$/.test(range ?? ''))

/**
 * The editor over the kind of material most of the web actually serves.
 *
 * Eighteen of the twenty-one live pages that delivered any video at all delivered it as an
 * ordinary file, and Edit used to answer "there is nothing to edit in this session yet" over
 * every one of them — beside a Save all button that saved the same file perfectly. Nothing of
 * such a file was ever intercepted, so the freeze fetches it, exactly as the save does, and puts
 * it in the snapshot whole for the editor to read the tables out of.
 */
for (const [container, source] of [
  ['an mp4', 'watched.mp4'],
  ['a Matroska', 'watched.webm'],
] as const) {
  test(`Edit opens the editor over ${container} and counts its frames`, async () => {
    // Eight seconds of watching, a freeze that fetches the material, and a decoder that has to
    // read the assembled clip before the player can step through it.
    test.setTimeout(90_000)

    const { context, page, popup, media, state } = await watchPartway(source)
    const held = state.buffered[0]![1]

    try {
      const opened = context.waitForEvent('page')
      await popup.getByRole('button', { name: 'Edit' }).click()

      const editor = await opened
      await editor.waitForLoadState('domcontentloaded')

      expect(
        new URL(editor.url()).searchParams.get('s'),
        'Edit did not open the editor over a snapshot',
      ).toBeTruthy()

      // No complaint on the screen: the four the editor knows are all about a snapshot it cannot
      // read, and this one was written a moment ago.
      await expect(editor.getByTestId('failure')).toHaveCount(0)

      // The preview is assembled out of the file, so the count is a fact about the material and
      // not about the index: the fixture runs at ten frames a second.
      const count = editor.getByTestId('frame-count')
      await expect(count).toBeVisible({ timeout: 30_000 })
      const frames = Number(await count.textContent())
      expect(frames).toBeGreaterThan(60)
      expect(Math.abs(frames / 10 - held), 'the editor holds a different length than was watched')
        .toBeLessThan(1.5)

      // And it plays: the element reads the clip the plan and the writer produced, and a step
      // moves the readout by exactly one frame.
      await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
      await expect(editor.getByTestId('timecode')).toHaveText('00:00:00:00')
      await editor.getByTestId('next').click()
      await expect(editor.getByTestId('frame')).toHaveText('2')
      await expect(editor.getByTestId('timecode')).toHaveText('00:00:00:01')
    } finally {
      await popup.close().catch(() => {})
      await page.close().catch(() => {})
      await context.close()
      await media.close()
    }
  })
}

for (const [layout, file] of [
  ['at the end of the file', 'watched.mp4'],
  ['at the front of the file', 'watched-faststart.mp4'],
] as const) {
  test(`saves an ordinary file whose movie box sits ${layout}`, async () => {
    // Two browsers, eight seconds of watching, and a clip played through to its end in real time
    // in the second of them: the default deadline of this suite is for tests that do none of that.
    test.setTimeout(150_000)

    const watched = await watchPartway(file)
    const { context, page, popup, media, state } = watched

    try {
      // Watched partway: the play head stopped well inside a twenty-second file.
      expect(state.currentTime).toBeGreaterThan(6)
      expect(state.currentTime).toBeLessThan(20)
      expect(state.duration).toBeCloseTo(20, 1)

      // What the element holds is one stretch from the head of the file. How far it reaches is
      // the browser's business — a <video src> fetches far ahead of the play head — and whatever
      // it is, it is what may be offered.
      expect(state.buffered).toHaveLength(1)
      expect(state.buffered[0]![0]).toBe(0)
      const held = state.buffered[0]![1]

      const shown = await promised(popup)
      const file_ = await saveAll(page, popup)
      // Snapshotted here, before anything else in this test asks the host for a byte.
      const reads = boundedReads(media)

      // The claim the whole design turns on: the popup promised the stretch that passed through
      // the player, and the file delivers exactly that. Within a second, because the popup rounds
      // to whole seconds and a clip ends on a frame boundary.
      expect(shown.seconds).toBeGreaterThan(6)
      expect(Math.abs(shown.seconds - held)).toBeLessThan(1.5)

      const probed = probeFile(file_)
      const duration = Number(probed.format.duration)

      expect(probed.streams.map((stream) => stream.codec_type).sort()).toEqual(['audio', 'video'])
      expect(probed.streams.map((stream) => stream.codec_name)).toEqual(['h264', 'aac'])
      expect(Math.abs(duration - shown.seconds)).toBeLessThan(1)
      expect(Math.abs(duration - held)).toBeLessThan(1)

      // Every frame read and every frame decoded, with nothing said about either.
      const frames = Number(
        probed.streams.find((stream) => stream.codec_type === 'video')!.nb_read_frames,
      )
      expect(frames).toBeGreaterThan(duration * 9)
      decodeFile(file_)

      // And played to the end in a browser that has never heard of this extension.
      const played = await playInBrowser(file_)
      expect(played.error).toBeNull()
      expect(played.ended, 'the saved file did not play through to its end').toBe(true)
      expect(played.reached).toBeGreaterThan(duration - 0.5)
      expect(played.videoBytes).toBeGreaterThan(0)
      expect(played.audioBytes).toBeGreaterThan(0)
      expect(played.frameColours).toBeGreaterThan(1)

      // Few and large. Every read with both ends stated is the extension's — the element asks
      // open-ended ones — and the whole save is three of them on this layout and two on the
      // other: the probe at the front, the movie box where the probe could not reach it, and one
      // read that brings every byte of the clip.
      //
      // Measured on watched.mp4: bytes=0-8191, bytes=46893-54718, bytes=48-46892. The last is the
      // material of the clip from its first sample to the end of the mdat, in one request.
      const head = layout === 'at the end of the file' ? ['bytes=0-8191', 'bytes=46893-54718'] : ['bytes=0-8191']
      expect(reads.slice(0, head.length), 'the tables were not read as expected').toEqual(head)
      expect(reads, 'the material was fetched in more than one request').toHaveLength(
        head.length + 1,
      )

      // Where the one read of the material begins: the first byte of the mdat payload, because
      // the clip starts at the head of the file. Its end is left to the browser — how far a
      // <video src> reads ahead is its business, and this test is about the shape of the reads.
      const material = /^bytes=(\d+)-(\d+)$/.exec(reads[head.length]!)!
      expect(Number(material[1])).toBe(layout === 'at the end of the file' ? 48 : 7874)
      expect(Number(material[2]) - Number(material[1])).toBeGreaterThan(20_000)

      // And the premise the whole arrangement rests on, checked rather than assumed: the page
      // itself cannot read its own video by a ranged fetch. The file is on another origin and the
      // host sends no CORS header — the refusal measured 48 times out of 57 on live pages, and
      // the reason the reads above are made from the extension frame instead. Last, because it
      // asks the host for bytes and would otherwise land in the tally.
      const fromPage = await page.evaluate(() =>
        (window as unknown as { tcFetch: () => Promise<string> }).tcFetch(),
      )
      expect(fromPage, 'the page could read its own media, so this test proves nothing').toMatch(
        /^refused/,
      )
    } finally {
      await popup.close().catch(() => {})
      await context.close()
      await media.close()
    }
  })
}

/**
 * The other container an ordinary file arrives in.
 *
 * A plain WebM was detected, listed and then honestly refused until now: the reader was written
 * for the segmented shape MSE delivers, where a cluster arrives on its own, and a complete
 * Matroska spreads its frames through clusters with no sample table anywhere to read instead.
 * Both rows here are whole files read by ranges out of the extension frame, cut to what the
 * element held, and written out as mp4.
 *
 * The pair is the point. VP9 and Opus are the codecs the captured path already converts, so that
 * row proves the reading. VP8 and Vorbis are the pair an imageboard serves, and neither had ever
 * been written into an mp4 by this program — nor, on the static evidence, could be: Chromium
 * answers `canPlayType('video/mp4; codecs="vp08.00.10.08"')` with an empty string and says the
 * same of Vorbis. That evidence is wrong for the path a saved file takes, and this row is what
 * says so: the file is played to its end in a browser that has never heard of this extension,
 * with pixels out of the picture decoder and bytes out of the sound one.
 */
for (const [name, file, codecs] of [
  ['VP9 and Opus', 'watched.webm', ['h264', 'aac']],
  ['VP8 and Vorbis', 'watched-vp8.webm', ['h264', 'aac']],
] as const) {
  test(`saves a whole Matroska of ${name}`, async () => {
    test.setTimeout(150_000)

    const { context, page, popup, media, state } = await watchPartway(file)

    try {
      expect(state.currentTime).toBeGreaterThan(6)
      expect(state.duration).toBeCloseTo(20, 1)
      expect(state.buffered).toHaveLength(1)
      expect(state.buffered[0]![0]).toBe(0)
      const held = state.buffered[0]![1]

      const shown = await promised(popup)
      const saved = await saveAll(page, popup)
      const reads = boundedReads(media)

      // The same promise the mp4 rows are held to: the popup offered the stretch that passed
      // through the player, and the file delivers exactly that.
      expect(shown.seconds).toBeGreaterThan(6)
      expect(Math.abs(shown.seconds - held)).toBeLessThan(1.5)

      const probed = probeFile(saved)
      const duration = Number(probed.format.duration)

      expect(probed.streams.map((stream) => stream.codec_type)).toEqual(['video', 'audio'])
      expect(probed.streams.map((stream) => stream.codec_name)).toEqual([...codecs])
      expect(Math.abs(duration - shown.seconds)).toBeLessThan(1)
      expect(Math.abs(duration - held)).toBeLessThan(1)

      // Every frame read and every frame decoded, with nothing said about either.
      const frames = Number(
        probed.streams.find((stream) => stream.codec_type === 'video')!.nb_read_frames,
      )
      expect(frames).toBeGreaterThan(duration * 9)
      decodeFile(saved)

      // And played to the end in a browser that has never heard of this extension — which for
      // these two codecs inside an mp4 is the whole of the evidence that it can be done.
      const played = await playInBrowser(saved)
      expect(played.error).toBeNull()
      expect(played.ended, 'the saved file did not play through to its end').toBe(true)
      expect(played.reached).toBeGreaterThan(duration - 0.5)
      expect(played.videoBytes).toBeGreaterThan(0)
      expect(played.audioBytes, 'no sound reached the decoder').toBeGreaterThan(0)
      expect(played.frameColours, 'the picture decoded to a flat field').toBeGreaterThan(1)

      // What it cost, stated rather than assumed. A Matroska has no sample table: the only
      // description of a frame is the block header in front of it, so the clusters have to be
      // walked and walking them means reading them. So the index is one pass over the file, the
      // save is one more read of the clip's own bytes, and the whole thing comes to under twice
      // the file — against two reads of a few kilobytes for an mp4 of the same material.
      expect(reads[0], 'the head was not the first thing read').toBe('bytes=0-8191')

      const asked = reads.reduce((sum, range) => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range)!
        return sum + Number(match[2]) - Number(match[1]) + 1
      }, 0)
      const size = state.duration > 0 ? await sizeOf(media.origin, file) : 0

      expect(asked).toBeGreaterThan(size)
      expect(asked, 'the file was read more times over than the index and the clip').toBeLessThan(
        size * 2.2,
      )
    } finally {
      await popup.close().catch(() => {})
      await context.close()
      await media.close()
    }
  })
}

/** How long the fixture is, asked of the host the same way anything else asks it. */
async function sizeOf(origin: string, file: string): Promise<number> {
  const answer = await fetch(`${origin}/${file}`, { headers: { Range: 'bytes=0-0' } })
  await answer.arrayBuffer()
  return Number(/\/(\d+)$/.exec(answer.headers.get('content-range') ?? '')?.[1] ?? 0)
}
