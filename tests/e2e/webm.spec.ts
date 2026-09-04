import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { audioSampleEntry, videoSampleEntry } from '../../src/core/iso/entry'
import {
  decodeFile,
  frameTimes,
  launchWithExtension,
  openPopupOn,
  playInBrowser,
  probeFile,
  saveAll,
  seekingLandsRight,
  serveLocal,
} from './helpers'

const PLAYER_URL = 'https://tailcut.test/webm'

/**
 * How long the player has to run for triage to let it through the probation period
 * (BALANCED.gracePeriodSeconds = 6). A second of slack for the polling of the watcher.
 */
const PLAY_MS = 7_000

/** Real-time playback of the saved clip on top of everything else the test does. */
const TIMEOUT_MS = 120_000

type PageState = { allAppended?: boolean; failure?: string | null }

/**
 * A page that serves its picture in WebM as well as its sound.
 *
 * This is what YouTube does whenever AV1 is not on offer: the sound comes as
 * audio/webm; codecs="opus" and the picture as video/webm; codecs="vp09…", two SourceBuffers of
 * one MediaSource and not an mp4 in sight. Which codec the site picks is not something the user
 * controls, so a clip saved from such a page has to come out whole — with a picture in it, and
 * with the keyframes still marked, or seeking inside the saved file lands on a frame that was
 * predicted from one the player never decoded.
 */
test('a clip whose picture came in WebM saves as one file that plays', async () => {
  test.setTimeout(TIMEOUT_MS)

  const { context, extensionId } = await launchWithExtension()
  const page = await context.newPage()
  await serveLocal(page, 'webm.html', PLAYER_URL)

  await page.waitForFunction(
    () => {
      const state = window as unknown as PageState
      return state.allAppended === true || state.failure != null
    },
    undefined,
    { timeout: 15_000 },
  )
  // A browser that refused either WebM buffer would leave the page reporting the refusal rather
  // than a clip, and everything below would be measuring nothing.
  expect(await page.evaluate(() => (window as unknown as PageState).failure ?? null)).toBeNull()

  await page.evaluate(() => document.querySelector('video')!.play())
  await page.waitForTimeout(PLAY_MS)

  const popup = await openPopupOn(context, page, extensionId)

  // Picture 0.014…6.014, sound 0…6.001: six seconds is what both tracks cover at once, and the
  // popup offers what can be cut and not what was collected.
  await expect(popup.getByTestId('duration')).toHaveText('0:06')

  const file = await saveAll(page, popup)
  const probed = probeFile(file)

  expect(probed.streams.map((stream) => [stream.codec_type, stream.codec_name])).toEqual([
    ['video', 'h264'],
    ['audio', 'aac'],
  ])
  expect(Number(probed.streams[0]!.nb_read_frames)).toBe(60)
  expect(frameTimes(file, 'a').at(-1)).toBeCloseTo(6, 1)
  expect(probed.streams[0]!.width).toBe(256)
  expect(probed.streams[0]!.height).toBe(144)
  // The decoded output remains eight-bit 4:2:0 after conversion to H.264.
  expect(probed.streams[0]!.pix_fmt).toBe('yuv420p')

  const seconds = Number(probed.format.duration)
  expect(seconds).toBeGreaterThan(5.9)
  expect(seconds).toBeLessThan(6.1)

  // The sync sample information, which a sample entry does not carry and a trun has to. The
  // material has a keyframe every two seconds, so each of these times sits in the middle of a
  // group of pictures: a seek to one of them is answered by the flags and by nothing else.
  seekingLandsRight(file, [1, 3, 5])

  // Read through by a decoder and not only by a parser: a picture described wrongly gets past the
  // headers and past a frame count, and turns into words on stderr only here.
  decodeFile(file)

  // And the last word belongs to a browser, which is where the file is going to be opened.
  const played = await playInBrowser(file)

  expect(played.error).toBeNull()
  expect(played.ended, 'playback did not reach the end of the clip').toBe(true)
  expect(played.duration).toBeGreaterThan(5.9)
  expect(played.reached).toBeGreaterThan(5.5)
  expect(played.audioTracks).toBe(1)
  expect(played.audioBytes, 'the browser decoded no sound at all').toBeGreaterThan(0)
  expect(played.videoBytes, 'the browser decoded no picture at all').toBeGreaterThan(0)

  // A frame off the element and into a canvas. Bytes going into a decoder are not pixels coming
  // out of one: a file the browser opens, sizes and runs to the end can still show a blank field
  // the whole way through.
  expect(played.frameError).toBeNull()
  expect([played.frameWidth, played.frameHeight]).toEqual([256, 144])
  expect(played.frameColours, 'the browser drew a blank frame').toBeGreaterThan(1)

  // MSE is no longer the door this file comes back in through: a byte stream wants an mvex and
  // moofs, and a progressive file has neither by design. What MSE was guarding is
  // guarded here directly — the sample entry of each track has to carry the box that describes
  // its codec, which is exactly what a decoder configuration is read out of. The ordinary
  // playback path above reads the frames instead and never notices a description that is missing.
  const saved = new Uint8Array(await readFile(file))

  const picture = videoSampleEntry(saved)
  expect(picture, 'the saved file has no picture sample entry at all').not.toBeNull()
  expect(picture!.format).toBe('avc1')
  expect([...picture!.children.keys()], 'the H.264 entry does not carry its avcC').toContain('avcC')
  expect([picture!.codedWidth, picture!.codedHeight]).toEqual([256, 144])

  const sound = audioSampleEntry(saved)
  expect(sound, 'the saved file has no sound sample entry at all').not.toBeNull()
  expect(sound!.format).toBe('mp4a')
  expect([...sound!.children.keys()], 'the AAC entry does not carry its esds').toContain('esds')

  await context.close()
})
