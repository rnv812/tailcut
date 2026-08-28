import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { openPlainFile, openSoundFile } from '../../src/bridge/loader'
import { SessionStore, planSave, summarize, type Session } from '../../src/bridge/session-store'
import { writeSaveFile } from '../../src/bridge/write'
import { probeFile, writeTemp } from '../support/media'

/**
 * The page shape this whole road exists for (§5.6), as the registry sees it.
 *
 * A `<video src>` of 3.5 s with no audio track in it, looping; an `<audio src>` of 24.5 s beside
 * it, seven times as long, looping on a cycle of its own. Measured on coub: 9.48 s of picture
 * under 66.35 s of soundtrack, the same ratio.
 */
const picture = new Uint8Array(readFileSync('tests/fixtures/plain/loop.mp4'))
const soundtrack = new Uint8Array(readFileSync('tests/fixtures/plain/track.mp3'))
/** The same six seconds with a picture and a sound of its own: a file that needs no pairing. */
const complete = new Uint8Array(readFileSync('tests/fixtures/plain/whole.mp4'))

const PAGE = 'https://coub.test/view/1'
const TITLE = 'A short loop under a long track'
const CLIP = 'https://cdn.example/loop.mp4'
const TRACK = 'https://sound.example/track.mp3'
const OTHER_TRACK = 'https://sound.example/other.mp3'
const SOURCE = `plain:${CLIP}`

/** The picture states 35 frames at ten a second. */
const LENGTH = 3.5

const bodyOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

/** A registry with a host behind it, and a tally of every request the host was asked for. */
function registry(files: Record<string, Uint8Array> = { [CLIP]: picture, [TRACK]: soundtrack }) {
  const asked: Array<{ url: string; bytes: number }> = []

  const call = (async (url: string, init?: RequestInit): Promise<Response> => {
    const file = files[url]
    const range = new Headers(init?.headers).get('range')
    const match = /bytes=(\d+)-(\d+)/.exec(range ?? '')

    if (!file || !match) {
      asked.push({ url, bytes: 0 })
      return new Response('gone', { status: 404 })
    }

    const from = Number(match[1])
    const to = Math.min(Number(match[2]), file.byteLength - 1)
    const part = file.subarray(from, to + 1)
    asked.push({ url, bytes: part.byteLength })

    return new Response(bodyOf(part), {
      status: 206,
      headers: { 'content-range': `bytes ${from}-${to}/${file.byteLength}` },
    })
  }) as unknown as typeof fetch

  const store = new SessionStore({
    openPlain: (url) => openPlainFile(url, { fetch: call }),
    openSound: (url, seconds) => openSoundFile(url, seconds, { fetch: call }),
  })

  return {
    store,
    asked,
    /** Bytes the host handed over for one address, all requests together. */
    served(url: string): number {
      let bytes = 0
      for (const one of asked) if (one.url === url) bytes += one.bytes
      return bytes
    },
    /** The page says a `<video>` of it is playing the picture. */
    shows(options: { buffered?: Array<[number, number]> } = {}): void {
      store.plain({
        sourceId: SOURCE,
        url: CLIP,
        pageUrl: PAGE,
        title: TITLE,
        durationSeconds: LENGTH,
        buffered: options.buffered ?? [[0, LENGTH]],
        now: 1000,
      })
    },
    /** The page says an `<audio>` of it is playing a soundtrack. */
    plays(
      options: { url?: string; playing?: boolean; buffered?: Array<[number, number]> } = {},
    ): void {
      const url = options.url ?? TRACK
      store.sound({
        sourceId: `sound:${url}`,
        url,
        durationSeconds: 24.5,
        buffered: options.buffered ?? [[0, 24.5]],
        playing: options.playing ?? true,
      })
    },
  }
}

/** A page playing both halves, watched long enough for the picture to be promoted. */
async function paired(files?: Record<string, Uint8Array>) {
  const page = registry(files)

  page.plays()
  page.shows()
  page.store.promotePending(SOURCE)
  await page.store.settled()
  // The read of the soundtrack begins inside the read of the picture, so a second turn of the
  // registry is needed before the pairing is in hand.
  page.shows()
  await page.store.settled()

  return page
}

/** Builds the file a save of this session would write, and reads it back through ffprobe. */
async function saved(session: Session, name: string) {
  const plan = planSave(session)
  const bytes = await writeSaveFile(plan.source)
  expect(bytes, 'the save produced no file').not.toBeNull()

  const file = writeTemp(name, bytes!)
  return { plan, file, probe: probeFile(file) }
}

describe('a page that plays its sound apart from its picture', () => {
  it('costs nothing for the soundtrack until a picture has asked for it', async () => {
    const page = registry()

    page.plays()
    page.shows()
    await page.store.settled()

    // The same rule the picture is under: nothing is fetched before triage has said somebody is
    // really watching. A page of muted looping previews with music behind it would otherwise pay
    // for a soundtrack apiece.
    expect(page.asked).toEqual([])
  })

  it('lays the soundtrack under the picture once the picture is promoted', async () => {
    const page = await paired()
    const [session] = page.store.list()

    expect(session?.plain?.sound?.url).toBe(TRACK)
    expect(summarize(session!).pairedSound).toBe(true)
  })

  it('promises the length of the picture and not of the track', async () => {
    const page = await paired()
    const summary = summarize(page.store.list()[0]!)

    // Seven times as much sound was on offer. The picture is the clip; the track is a thing
    // playing underneath it, and the extra twenty-one seconds are somebody's music.
    expect(summary.duration).toBeCloseTo(LENGTH, 1)
  })

  it('reads only as much of the track as the picture is long', async () => {
    const page = await paired()

    // The whole track is 98 kB and a clip of three and a half seconds can use fourteen of them.
    // §2 puts downloading somebody's material out of scope, and a soundtrack is a music file.
    expect(page.served(TRACK)).toBeLessThan(40_000)
    expect(page.served(TRACK)).toBeGreaterThan(0)
  })

  it('leaves a file that has sound of its own alone', async () => {
    const page = await paired({ [CLIP]: complete, [TRACK]: soundtrack })
    const [session] = page.store.list()

    // A track from outside is an answer to a picture that has none. Adding a second beside the
    // file's own would be composing rather than clipping — and it would fetch a soundtrack for
    // every page that happens to play music behind a video with its own sound.
    expect(session?.plain?.sound).toBeUndefined()
    expect(summarize(session!).pairedSound).toBeUndefined()
    expect(page.served(TRACK)).toBe(0)
  })

  it('says the clip is silent when the track cannot be read', async () => {
    const page = await paired({ [CLIP]: picture })
    const [session] = page.store.list()

    // The address answered 404 — expired, moved, gone. The picture is still worth saving and the
    // file it makes is silent, which the popup must say rather than leave to be discovered.
    expect(session?.plain?.sound).toBeUndefined()
    expect(summarize(session!).omits).toBe('sound')
  })

  it('says the same when two tracks are playing and nothing can say which is the picture’s', async () => {
    const page = registry({ [CLIP]: picture, [TRACK]: soundtrack, [OTHER_TRACK]: soundtrack })

    page.plays()
    page.plays({ url: OTHER_TRACK })
    page.shows()
    page.store.promotePending(SOURCE)
    await page.store.settled()
    page.shows()
    await page.store.settled()

    const [session] = page.store.list()
    // Guessing which of two belongs to the picture would put a stranger's sound into somebody's
    // clip, and nothing this can see settles it. Neither is read at all.
    expect(session?.plain?.sound).toBeUndefined()
    expect(summarize(session!).omits).toBe('sound')
    expect(page.served(TRACK)).toBe(0)
  })

  it('says nothing at all about a silent picture on a page with no sound on it', async () => {
    const page = registry({ [CLIP]: picture })

    page.shows()
    page.store.promotePending(SOURCE)
    await page.store.settled()

    const [session] = page.store.list()
    // A silent video is not a loss. The sentence is for a page whose sound was somewhere tailcut
    // could not follow, and there is no sound here to have followed.
    expect(summarize(session!).omits).toBeUndefined()
    expect(summarize(session!).pairedSound).toBeUndefined()
  })

  it('ignores a track that is standing still', async () => {
    const page = registry()

    page.plays({ playing: false })
    page.shows()
    page.store.promotePending(SOURCE)
    await page.store.settled()
    page.shows()
    await page.store.settled()

    const [session] = page.store.list()
    expect(session?.plain?.sound).toBeUndefined()
    expect(summarize(session!).omits).toBeUndefined()
    expect(page.served(TRACK)).toBe(0)
  })

  it('takes the pairing up when the track starts playing later', async () => {
    const page = registry()

    page.shows()
    page.store.promotePending(SOURCE)
    await page.store.settled()
    expect(page.store.list()[0]?.plain?.sound).toBeUndefined()

    page.plays()
    await page.store.settled()

    expect(page.store.list()[0]?.plain?.sound?.url).toBe(TRACK)
  })

  it('offers only what the element holds of the track from its start', async () => {
    const page = registry()

    // A track the browser has one second of. What is offered is what really passed through the
    // player, which is the same promise the picture is held to (§5.6).
    page.plays({ buffered: [[0, 1]] })
    page.shows()
    page.store.promotePending(SOURCE)
    await page.store.settled()
    page.shows()
    await page.store.settled()

    const summary = summarize(page.store.list()[0]!)
    // The clip is still the picture's length, and it ends in silence — which is said out loud.
    expect(summary.duration).toBeCloseTo(LENGTH, 1)
    expect(summary.omits).toBe('soundShort')
  })

  it('writes a file that plays with both tracks', async () => {
    const page = await paired()
    const { plan, probe } = await saved(page.store.list()[0]!, 'sound-apart-session.mp4')

    expect(probe.stderr, 'ffmpeg complains about reading the paired file').toBe('')
    expect(probe.probed?.streams.map((one) => [one.codec_type, one.codec_name])).toEqual([
      ['video', 'h264'],
      ['audio', 'mp3'],
    ])

    // Thirty-five frames of picture at ten a second, and sound under all of them.
    const [video, audio] = probe.probed!.streams
    expect(Number(video!.nb_read_frames)).toBe(35)
    expect(Number(audio!.duration)).toBeCloseTo(LENGTH, 1)
    expect(plan.pairedSound).toBe(true)
  })

  it('fetches each half of the file from the host it lives on', async () => {
    const page = await paired()
    const before = page.asked.length

    await writeSaveFile(planSave(page.store.list()[0]!).source)

    // Two files in one clip and one address space over them: a read that went to the wrong host
    // would write the head of a soundtrack into the middle of the picture.
    const reads = page.asked.slice(before)
    expect(reads.some((one) => one.url === CLIP)).toBe(true)
    expect(reads.some((one) => one.url === TRACK)).toBe(true)
    expect(reads.every((one) => one.bytes > 0)).toBe(true)
  })
})

describe('a page that plays its sound apart, paused', () => {
  it('keeps the pairing when the viewer pauses to open the popup', async () => {
    const page = await paired()

    // Which is what a viewer does before saving. §5.5: a pause freezes and does not erase, and
    // read live the page is silent at exactly the moment somebody is deciding to save from it.
    page.plays({ playing: false })
    await page.store.settled()

    expect(page.store.list()[0]?.plain?.sound?.url).toBe(TRACK)
  })

  it('will not guess between two tracks the page has played in turn', async () => {
    const page = registry({ [CLIP]: picture, [TRACK]: soundtrack, [OTHER_TRACK]: soundtrack })

    page.plays()
    page.plays({ playing: false })
    page.plays({ url: OTHER_TRACK })
    page.shows()
    page.store.promotePending(SOURCE)
    await page.store.settled()
    page.plays({ url: OTHER_TRACK, playing: false })
    page.shows()
    await page.store.settled()

    // A feed or a playlist: two tracks have played and neither is playing now. Nothing here can
    // say which one belonged to the picture, and a stranger's sound in somebody's clip is worse
    // than a silent clip with a sentence beside it.
    expect(page.store.list()[0]?.plain?.sound).toBeUndefined()
    expect(summarize(page.store.list()[0]!).omits).toBe('sound')
  })

  it('prefers the track that is playing now over one that has stopped', async () => {
    const page = registry({ [CLIP]: picture, [TRACK]: soundtrack, [OTHER_TRACK]: soundtrack })

    page.plays({ url: OTHER_TRACK })
    page.plays({ url: OTHER_TRACK, playing: false })
    page.plays()
    page.shows()
    page.store.promotePending(SOURCE)
    await page.store.settled()
    page.shows()
    await page.store.settled()

    // One has played and stopped, one is playing: the page is answering the question itself.
    expect(page.store.list()[0]?.plain?.sound?.url).toBe(TRACK)
  })
})

describe('a soundtrack the browser is still downloading', () => {
  it('reaches further as the element holds more of the track', async () => {
    const page = registry()

    // One second held at first: the clip is the picture's length either way and its tail is
    // silent, which the popup says.
    page.plays({ buffered: [[0, 1]] })
    page.shows()
    page.store.promotePending(SOURCE)
    await page.store.settled()
    page.shows()
    await page.store.settled()
    expect(summarize(page.store.list()[0]!).omits).toBe('soundShort')

    // The download makes headway and the sound now covers the whole picture.
    page.plays({ buffered: [[0, 24.5]] })
    await page.store.settled()

    expect(summarize(page.store.list()[0]!).omits).toBeUndefined()
    expect(summarize(page.store.list()[0]!).pairedSound).toBe(true)
  })

  it('keeps the sound it has while the longer read is on its way', async () => {
    const page = registry()

    page.plays({ buffered: [[0, 1]] })
    page.shows()
    page.store.promotePending(SOURCE)
    await page.store.settled()
    page.shows()
    await page.store.settled()

    // The report arrives and the read it sets going has not come back yet. Dropped in the
    // meantime, the popup would lose the line about the sound and get it back a moment later —
    // and a save made in between would come out silent.
    page.plays({ buffered: [[0, 24.5]] })

    expect(page.store.list()[0]?.plain?.sound?.url).toBe(TRACK)
    expect(summarize(page.store.list()[0]!).pairedSound).toBe(true)
  })
})
