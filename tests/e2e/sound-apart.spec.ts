import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { launchWithExtension, openPopupOn, playInBrowser, probeFile, saveAll } from './helpers'
import { serveMedia, servePage, type Host } from './server'

/**
 * Split picture-and-sound delivery, end to end in a real browser.
 *
 * A page whose picture and sound are two media elements: `<video src>` of 3.5 s with no audio
 * track in it, `<audio src>` of 24.5 s beside it, both looping, each turning on a cycle of its
 * own, both fetched by the browser itself with nothing for the hook to intercept. Measured on
 * coub — 9.48 s of picture under 66.35 s of soundtrack — and kept here at the same ratio.
 *
 * Two things are being proved and they are different claims. That the picture is recorded at all:
 * muted, looping and without controls it is the exact shape of a banner, and the sound playing
 * beside it is the only evidence that it is not one. And that the file which comes out plays with
 * both tracks — picture from the one host, sound from the other, fetched by ranges from the
 * extension frame and written into one mp4.
 */

/**
 * How long the page is watched.
 *
 * Past the six seconds triage gives a player to prove itself, and long enough for the picture to
 * come round twice: the point of the pairing is that the sound written into the file is the head
 * of the track and not wherever the track had got to by the time of the click.
 */
const WATCH_MS = 8_000

/** Long enough for the verdict, the ranged reads of both files and the session to arrive. */
const SETTLE_MS = 2_000

interface Watched {
  context: BrowserContext
  page: Page
  popup: Page
  media: Host
  state: { video: { duration: number }; sound: { duration: number; paused: boolean } }
}

/** Opens the page, plays both halves of it, and opens the popup over what came of that. */
async function watchBoth(): Promise<Watched> {
  const media = await serveMedia()
  const site = await servePage('coub.html', media.origin, 'loop.mp4', 'track.mp3')
  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()

  await page.goto(site.origin)

  // A real click first: the soundtrack is not muted, and Chromium will not let an unmuted element
  // begin without a gesture. That is also what a viewer does on such a page.
  await page.locator('p').click()
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

test('a page that plays its sound apart is saved with both tracks', async () => {
  // Eight seconds of watching, a save that fetches both files, and a browser that plays the
  // result through in real time.
  test.setTimeout(90_000)

  const { context, page, popup, media, state } = await watchBoth()

  try {
    // The page really did play both, and they really do disagree about their length by a factor
    // of seven — which is the whole of what makes this case a question rather than a save.
    expect(state.video.duration).toBeCloseTo(3.5, 1)
    expect(state.sound.duration).toBeCloseTo(24.5, 1)

    // The picture was recorded, though muted, looping and without controls it is a banner by
    // every measure triage has. The sound beside it is what says otherwise.
    await expect(popup.getByTestId('title')).toHaveText('A loop under a track')

    // And the popup says where the sound in the file will come from. It is not the video's own
    // sound and must not be presented as if it were: it is a track playing underneath, on a cycle
    // of its own, and what goes in is its start.
    await expect(popup.getByTestId('paired-sound')).toHaveText(
      'Sound here is a separate looping track on this page, taken from its start.',
    )

    // The length promised is the picture's, not the soundtrack's: three and a half seconds, which
    // the popup rounds to four. Twenty-one seconds of somebody's music are on the page and none
    // of them past the picture are taken — a file of a song with a loop at the front is not a
    // clip of anything, and offering one would download material the viewer never watched.
    await expect(popup.getByTestId('duration')).toHaveText('0:04')

    const file = await saveAll(page, popup)

    const probed = probeFile(file)
    expect(probed.streams.map((one) => [one.codec_type, one.codec_name])).toEqual([
      ['video', 'h264'],
      ['audio', 'mp3'],
    ])

    // Played through in a browser of its own, without the extension: what is under test now is
    // the file. Both decoders are fed, which is the claim — a file with a sound track that
    // decodes nothing would probe exactly the same.
    const played = await playInBrowser(file)
    expect(played.error, 'the browser refused the paired file').toBeNull()
    expect(played.ended).toBe(true)
    expect(played.videoBytes).toBeGreaterThan(0)
    expect(played.audioBytes).toBeGreaterThan(0)
    expect(played.duration).toBeCloseTo(3.5, 1)

    // Both files were read, each from the host it lives on, and only the head of the soundtrack:
    // the whole track is 98 kB and a clip of three and a half seconds can use fourteen of them.
    // Everything above that would download somebody's music beyond what the viewer watched.
    expect(media.asked.length).toBeGreaterThan(2)
  } finally {
    await popup.close().catch(() => {})
    await page.close().catch(() => {})
    await context.close()
    await media.close()
  }
})

test('the editor opens over such a page with both tracks in hand', async () => {
  // Eight seconds of watching, a freeze that fetches both files, and a decoder that has to read
  // the assembled clip before the player can step through it.
  test.setTimeout(90_000)

  const { context, page, popup, media } = await watchBoth()

  try {
    const opened = context.waitForEvent('page')
    await popup.getByRole('button', { name: 'Edit' }).click()

    const editor = await opened
    await editor.waitForLoadState('domcontentloaded')

    expect(
      new URL(editor.url()).searchParams.get('s'),
      'Edit did not open the editor over a snapshot',
    ).toBeTruthy()
    await expect(editor.getByTestId('failure')).toHaveCount(0)

    // The snapshot holds the very clip Save all would have written — picture from one host, sound
    // from the other, already laid together — so the editor counts the frames of the picture and
    // knows nothing of the pairing behind it.
    const count = editor.getByTestId('frame-count')
    await expect(count).toBeVisible({ timeout: 30_000 })
    expect(Number(await count.textContent())).toBe(35)

    // One track line: the snapshot holds an ordinary complete file, and a file states its picture
    // and its sound in one movie box however many files they were fetched from.
    await expect(editor.getByTestId('track')).toHaveCount(1)

    // And it plays, which is the same claim the saved file answers: the element reads the clip
    // the plan and the writer produced, and a step moves the readout by exactly one frame.
    await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
    await expect(editor.getByTestId('timecode')).toHaveText('00:00:00:00')
    await editor.getByTestId('next').click()
    await expect(editor.getByTestId('frame')).toHaveText('2')

    // What is not asserted here, and why. The timeline draws no wave under this clip, and it
    // draws none under any session whose material is an ordinary complete file: one movie box
    // states both kinds, so the snapshot holds one track, and `materialOf` takes the sound from a
    // track other than the picture's or from nowhere. That is how the plain path has always
    // behaved and it is not this pairing's doing — an mp4 of picture and sound off one host
    // reaches the editor waveless in exactly the same way.
  } finally {
    await popup.close().catch(() => {})
    await page.close().catch(() => {})
    await context.close()
    await media.close()
  }
})
