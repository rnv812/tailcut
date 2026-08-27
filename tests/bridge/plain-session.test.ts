import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { openPlainFile } from '../../src/bridge/loader'
import { SessionStore, planSave, summarize, type Session } from '../../src/bridge/session-store'
import { writeSaveFile } from '../../src/bridge/write'
import { sessionKey } from '../../src/core/session-key'
import { topLevelBoxes } from '../../src/core/iso/reader'
import { fullBoxOf, u32, zeroes } from '../../src/core/iso/writer'
import { decodeWarnings, probeFile, writeTemp } from '../support/media'

const whole = new Uint8Array(readFileSync('tests/fixtures/plain/whole.mp4'))

const PAGE = 'https://example.test/article'
const TITLE = 'An article with a video in it'
const CLIP = 'https://cdn.example/clip.mp4'
const OTHER = 'https://cdn.example/other.mp4'
const SOURCE = `plain:${CLIP}`

/** The file states 60 frames at 10240 ticks with 1024 apiece: six seconds of picture. */
const LENGTH = 6

/** A Response takes a view over a plain ArrayBuffer and not one that might be shared memory. */
const bodyOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

/**
 * A registry with a host behind it, and a tally of every request the host was asked for.
 *
 * The tally is half of what this set is about: a plain source must cost nothing at all until
 * triage has said the element is worth recording, and "nothing at all" is a claim about requests.
 */
function registry(files: Record<string, Uint8Array> = { [CLIP]: whole }) {
  const asked: string[] = []

  const call = (async (url: string, init?: RequestInit): Promise<Response> => {
    asked.push(url)
    const file = files[url]
    if (!file) return new Response('gone', { status: 404 })

    const range = new Headers(init?.headers).get('range')
    const match = /bytes=(\d+)-(\d+)/.exec(range ?? '')!
    const from = Number(match[1])
    const to = Math.min(Number(match[2]), file.byteLength - 1)
    const part = file.subarray(from, to + 1)

    return new Response(bodyOf(part), {
      status: 206,
      headers: { 'content-range': `bytes ${from}-${to}/${file.byteLength}` },
    })
  }) as unknown as typeof fetch

  const store = new SessionStore({
    openPlain: (url) => openPlainFile(url, { fetch: call }),
  })

  return {
    store,
    asked,
    /** How many files were opened: two ranged reads apiece on this layout. */
    get opens(): number {
      return asked.length
    },
    /** The page says an element of it is playing a file, the way the watcher reports one. */
    says(options: {
      url?: string
      buffered?: Array<[number, number]>
      seconds?: number
      now?: number
      title?: string
    } = {}): void {
      const url = options.url ?? CLIP
      store.plain({
        sourceId: `plain:${url}`,
        url,
        pageUrl: PAGE,
        title: options.title ?? TITLE,
        durationSeconds: options.seconds ?? LENGTH,
        buffered: options.buffered ?? [[0, LENGTH]],
        now: options.now ?? 1000,
      })
    },
  }
}

/**
 * The same file with a `pssh` put inside its movie box: the header of a protection system, which
 * is one of the three places Common Encryption shows itself. The chunk offsets stay true — the
 * box grows behind the material, not in front of it.
 */
function withPssh(file: Uint8Array): Uint8Array {
  const moov = topLevelBoxes(file).find((box) => box.type === 'moov')!
  const pssh = fullBoxOf('pssh', 0, 0, zeroes(16), u32(0))
  const at = moov.start + moov.headerSize

  const out = new Uint8Array(file.byteLength + pssh.byteLength)
  out.set(file.subarray(0, at), 0)
  out.set(pssh, at)
  out.set(file.subarray(at), at + pssh.byteLength)
  new DataView(out.buffer).setUint32(moov.start, moov.size + pssh.byteLength)

  return out
}

const keyOf = (url = CLIP, seconds = LENGTH): string =>
  sessionKey({ url, codecs: ['avc1', 'mp4a'], durationSeconds: seconds })

/** Builds the file a save of this session would write, and reads it back through ffprobe. */
async function saved(session: Session, name: string) {
  const plan = planSave(session)
  const bytes = await writeSaveFile(plan.source)
  expect(bytes, 'the save produced no file').not.toBeNull()

  const file = writeTemp(name, bytes!)
  return { plan, file, probe: probeFile(file) }
}

describe('an ordinary file in the registry', () => {
  it('costs nothing at all until triage has promoted it', async () => {
    const page = registry()

    page.says()
    page.says({ buffered: [[0, 3]] })
    await page.store.settled()

    // Ten of the eighteen measured pages that deliver a plain file hold nothing but muted looping
    // previews. A request apiece for those would be the whole cost of recording, spent on
    // material that is refused a moment later.
    expect(page.asked).toEqual([])
    expect(page.store.list()).toEqual([])
  })

  it('is never opened while its verdict stands against it', async () => {
    const page = registry()

    page.says()
    page.store.dropPending(SOURCE)
    page.says({ buffered: [[0, 4]] })
    await page.store.settled()

    expect(page.asked).toEqual([])
    expect(page.store.list()).toEqual([])
  })

  it('becomes a session the moment it is promoted, signed with the page it plays on', async () => {
    const page = registry()

    page.says()
    page.store.promotePending(SOURCE)
    await page.store.settled()

    const [session] = page.store.list()
    expect(session).toBeDefined()
    // The address and the title of the frame, exactly as a captured session is signed: the popup
    // shows the page the user was watching, not the CDN the bytes came off.
    expect(session!.url).toBe(PAGE)
    expect(session!.title).toBe(TITLE)
    expect(session!.key).toBe(keyOf())
    // Two ranged reads: the front of the file, and the movie box behind the material.
    expect(page.opens).toBe(2)
  })

  it('is keyed by the address of the file, so two of them on one page are two sessions', async () => {
    // The same three components as any other session (§6.1) — an address, the codecs, the length
    // — with the address being the address of the material. For a stream out of MediaSource there
    // is none and the page stands in for it; for a file there is one, and it is the better answer:
    // two clips on one page share every other component and would otherwise share a session.
    const page = registry({ [CLIP]: whole, [OTHER]: whole })

    page.says()
    page.says({ url: OTHER })
    page.store.promotePending(SOURCE)
    page.store.promotePending(`plain:${OTHER}`)
    await page.store.settled()

    expect(page.store.list().map((session) => session.key).sort()).toEqual(
      [keyOf(CLIP), keyOf(OTHER)].sort(),
    )
  })

  it('opens one file once, however many elements of the page play it', async () => {
    const page = registry()

    page.says()
    page.store.promotePending(SOURCE)
    await page.store.settled()
    page.says({ buffered: [[0, LENGTH]], now: 2000 })
    await page.store.settled()

    expect(page.opens).toBe(2)
    expect(page.store.list()).toHaveLength(1)
  })

  it('says nothing about a file it could not read, and does not go back for it', async () => {
    const page = registry({})

    page.says()
    page.store.promotePending(SOURCE)
    await page.store.settled()
    expect(page.store.list()).toEqual([])

    page.says({ buffered: [[0, 5]] })
    await page.store.settled()

    // One attempt and no more: an address that answers 404 will answer 404 on the next poll too,
    // and the poll runs twice a second for as long as the page is open.
    expect(page.opens).toBe(1)
  })
})

describe('an ordinary file under the same triage as any other source', () => {
  it('does not become a session when the verdict turns against it mid-read, and does when it turns back', async () => {
    // Probation (§5.4), and what is left of it here. The captured path has to carry its material
    // out of the registry and back in again, because the bytes went past once and exist nowhere
    // else; a file never moved, so a rejection has only to leave it unlisted. The one moment the
    // two paths can differ is this one — the tables are being read when the verdict turns — and
    // the answer is the same: nothing is offered under a rejection.
    const page = registry()

    page.says()
    page.store.promotePending(SOURCE)
    page.store.dropPending(SOURCE)
    await page.store.settled()

    expect(page.store.list(), 'a rejected file was offered for saving').toEqual([])

    page.store.resumePending(SOURCE)
    const back = page.store.list()[0]

    expect(back?.key).toBe(keyOf())
    expect(back?.title).toBe(TITLE)
    expect(summarize(back!).duration).toBeGreaterThan(5.5)
    // And it was not read a second time to come back: the index never left.
    expect(page.opens).toBe(2)
  })

  it('freezes rather than disappears once it has been confirmed', async () => {
    const page = registry()

    page.says({ buffered: [[0, 3]] })
    page.store.promotePending(SOURCE)
    await page.store.settled()
    const before = summarize(page.store.list()[0]!)

    page.store.dropPending(SOURCE)
    page.says({ buffered: [[0, LENGTH]] })
    await page.store.settled()

    // A pause, a hidden tab, an element off the screen: the recording stops growing and what was
    // gathered stays. The stretch on offer is the stretch that was on offer when it froze.
    const frozen = page.store.list()[0]
    expect(frozen, 'a confirmed session was taken away by a rejection').toBeDefined()
    expect(summarize(frozen!)).toEqual(before)
  })

  it('is refused with the whole page when the file itself carries protection', async () => {
    // The evidence is the boxes and not anything the page said (§5.4). An encrypted file reaching
    // the registry refuses the page, and there is no later moment that turns it.
    const page = registry({ [CLIP]: withPssh(whole) })
    page.says()
    page.store.promotePending(SOURCE)
    await page.store.settled()

    expect(page.store.encrypted).toBe(true)
    expect(page.store.list()).toEqual([])
  })
})

describe('what an ordinary file promises, and what it delivers', () => {
  it('offers the stretch the element holds and not the file behind it', async () => {
    const page = registry()

    page.says({ buffered: [[0, 2.5]] })
    page.store.promotePending(SOURCE)
    await page.store.settled()

    const session = page.store.list()[0]!
    const summary = summarize(session)

    // The file is six seconds long and whole and reachable. What is offered is what passed
    // through the player, which is the promise §2 makes about every other source too.
    expect(summary.duration).toBeGreaterThan(2.4)
    expect(summary.duration).toBeLessThan(2.6)

    const { probe } = await saved(session, 'plain-session-partial.mp4')
    expect(probe.stderr).toBe('')
    expect(Number(probe.probed!.format.duration)).toBeCloseTo(summary.duration, 1)
  })

  it('writes a file of exactly the length the popup was shown', async () => {
    const page = registry()

    page.says()
    page.store.promotePending(SOURCE)
    await page.store.settled()

    const session = page.store.list()[0]!
    const summary = summarize(session)
    const { file, probe } = await saved(session, 'plain-session-whole.mp4')

    expect(probe.stderr, 'ffprobe complains about the saved file').toBe('')
    expect(decodeWarnings(file), 'the decoder complained about the saved file').toBe('')
    expect(probe.probed!.streams.map((stream) => stream.codec_name)).toEqual(['h264', 'aac'])
    expect(Number(probe.probed!.format.duration)).toBeCloseTo(summary.duration, 1)
    expect(summary.omits).toBeUndefined()
  })

  it('says a gap out loud and saves the longest piece', async () => {
    const page = registry()

    // A file the viewer jumped forward inside: the browser holds the head and the tail and
    // nothing between them.
    page.says({ buffered: [[0, 1], [3, LENGTH]] })
    page.store.promotePending(SOURCE)
    await page.store.settled()

    const session = page.store.list()[0]!
    const summary = summarize(session)

    expect(summary.omits).toBe('gap')
    expect(summary.duration).toBeCloseTo(3, 0)

    const { probe } = await saved(session, 'plain-session-gap.mp4')
    expect(probe.stderr).toBe('')
    expect(Number(probe.probed!.format.duration)).toBeCloseTo(summary.duration, 1)
  })

  it('answers nothing to save while the element holds nothing', async () => {
    const page = registry()

    page.says({ buffered: [], seconds: 0 })
    page.store.promotePending(SOURCE)
    await page.store.settled()

    const session = page.store.list()[0]!
    expect(summarize(session)).toEqual({ duration: 0, bytes: 0 })
    expect(await writeSaveFile(planSave(session).source)).toBeNull()
  })

  it('gives up the material eviction has taken, and keeps giving it up', async () => {
    const page = registry()

    page.says()
    page.store.promotePending(SOURCE)
    await page.store.settled()
    const whole_ = summarize(page.store.list()[0]!).duration

    // Two seconds of buffer around a play head at the end of the file: the same rule the captured
    // maps are evicted by, over the other kind of material.
    page.store.evictAll(2, LENGTH)
    const kept = summarize(page.store.list()[0]!).duration

    expect(kept).toBeLessThan(whole_)
    expect(kept).toBeCloseTo(2, 0)

    // And the page saying again that it holds the whole file does not bring it back: what was
    // evicted is gone, whichever kind of material it was.
    page.says({ buffered: [[0, LENGTH]], now: 3000 })
    await page.store.settled()
    expect(summarize(page.store.list()[0]!).duration).toBeCloseTo(kept, 5)
  })
})
