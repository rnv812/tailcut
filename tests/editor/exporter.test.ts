// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { downloadIo, openClipSource, planOf, requestsFor } from '../../src/editor/export/exporter'
import { planSnapshot, type SnapshotSource } from '../../src/core/snapshot/build'
import { SnapshotReader } from '../../src/core/snapshot/read'
import { materialOf } from '../../src/core/snapshot/material'
import { concatBytes } from '../../src/core/iso/writer'
import { topLevelBoxes } from '../../src/core/iso/reader'
import { parseInit } from '../../src/core/iso/init'
import { assembleMp4 } from '../../src/core/export/assemble'
import { clipSourceFrom, movieTracksOf } from '../../src/core/export/source'
import { NO_ENCODER, createRunner } from '../../src/core/export/run'
import type { Clip } from '../../src/core/edit/clip'
import { EMPTY_CONTEXT } from '../../src/core/edit/context'
import type { ExportRequest } from '../../src/core/export/run'

const read = (path: string): Uint8Array => new Uint8Array(readFileSync(`tests/fixtures/${path}`))

/** The movie box of a complete file, where its sample tables live. */
const moovOf = (file: Uint8Array): Uint8Array => {
  const moov = topLevelBoxes(file).find((box) => box.type === 'moov')!
  return file.subarray(moov.start, moov.start + moov.size)
}

/** The captured shape: an init segment and media segments, walked for their moofs. */
const INIT = read('h264/init-stream0.m4s')
const SEGMENTS = [1, 2, 3].map((n) => read(`h264/chunk-stream0-0000${n}.m4s`))

/**
 * The other shape, and the common one: an ordinary complete file the extension never intercepted.
 *
 * Six seconds, sixty frames at 256×144 with sound beside them, and its movie box at the very end.
 * Eighteen of the twenty-one live pages that delivered video at all delivered it like this, so a
 * path that only knows about fragments is a path that cannot export most of the web.
 */
const WHOLE = read('plain/whole.mp4')

/**
 * One buffer carrying both kinds, as a page that muxes its own material sends them.
 *
 * Two traks in the init and two trafs in every segment, and each trak states an edit list of its
 * own. There is no second stream anywhere: the sound of this recording exists only inside the
 * segments the picture arrived in.
 */
const MUXED_INIT = read('muxed-edits/init-stream0.m4s')
const MUXED_SEGMENTS = [1, 2, 3].map((n) => read(`muxed-edits/chunk-stream0-0000${n}.m4s`))

const page = {
  sessionKey: 'https://site.example/watch|avc1|inf',
  url: 'https://site.example/watch?v=abc',
  title: 'Clip — site.example',
  createdAt: 1_756_022_100_000,
  lastSeenAt: 1_756_022_399_000,
  refusedTracks: false,
}

async function snapshotFrom(source: SnapshotSource): Promise<SnapshotReader> {
  const plan = planSnapshot(source, { id: 'x', capturedAt: 1_756_022_400_000, producer: 'test' })
  const file = concatBytes(plan.parts)
  const reader = await SnapshotReader.open(
    async (at, length) => file.subarray(at, at + length),
    file.byteLength,
  )
  return reader!
}

const capturedTrack = {
  id: 't0',
  bufferId: 'sb-1',
  representation: 'video:avc1.4d401e:320x240',
  kinds: ['video' as const],
  info: {
    tracks: [
      {
        trackId: 1,
        kind: 'video' as const,
        timescale: 12_288,
        codec: 'avc1.4d401e',
        width: 320,
        height: 240,
      },
    ],
  },
  initBytes: INIT,
}

/** A snapshot of segments, laid out at the seconds they were watched at. */
const capturedSnapshot = (): Promise<SnapshotReader> =>
  snapshotFrom({
    page,
    tracks: [
      {
        ...capturedTrack,
        chunks: SEGMENTS.map((bytes, at) => ({ start: at * 2, end: at * 2 + 2, bytes })),
      },
    ],
  })

/**
 * A snapshot of one ordinary file, with its movie box named inside it — and something in front.
 *
 * The something matters. A file laid down first begins at byte zero of the snapshot, and there a
 * table read as if it addressed its own file and a table read as if it addressed the snapshot say
 * exactly the same thing. Two seconds of captured material ahead of it moves the file off zero,
 * and the two readings part company by that many bytes.
 */
const fileSnapshot = (): Promise<SnapshotReader> => {
  const moov = topLevelBoxes(WHOLE).find((box) => box.type === 'moov')!

  return snapshotFrom({
    page,
    tracks: [
      {
        ...capturedTrack,
        // Two seconds against the file's six, so the file is still the richest picture there is
        // and the editor opens on it.
        chunks: [{ start: 0, end: 2, bytes: SEGMENTS[0]! }],
      },
      {
        id: 't1',
        bufferId: 'file',
        representation: 'file:avc1+mp4a',
        kinds: ['video', 'audio'],
        info: parseInit(WHOLE)!,
        initBytes: WHOLE,
        movie: { at: moov.start, length: moov.size },
        chunks: [{ start: 0, end: 6, bytes: new Uint8Array(0) }],
      },
    ],
  })
}

/** That buffer as a snapshot: one captured track, both kinds, no file to fall back on. */
const muxedSnapshot = (): Promise<SnapshotReader> =>
  snapshotFrom({
    page,
    tracks: [
      {
        id: 't0',
        bufferId: 'sb-1',
        representation: 'muxed:avc1.4d401e+mp4a.40.2:320x240',
        kinds: ['video', 'audio'],
        info: parseInit(MUXED_INIT)!,
        initBytes: MUXED_INIT,
        chunks: MUXED_SEGMENTS.map((bytes, at) => ({ start: at * 2, end: at * 2 + 2, bytes })),
      },
    ],
  })

const clip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c1',
  name: 'A page about cats 01.23',
  in: 1,
  out: 3,
  representation: '480p',
  sound: true,
  crop: null,
  format: 'mp4',
  mode: 'original',
  ...over,
})

const requests = (source: Parameters<typeof requestsFor>[0], clips: readonly Clip[]) =>
  requestsFor(source, clips, EMPTY_CONTEXT, new Map(), false)

const copyPlan = (request: ExportRequest) => {
  if (request.path.kind !== 'copy') throw new Error('the fixture did not take the copy path')
  return request.path.plan
}

describe('openClipSource', () => {
  it('indexes the samples of captured material and addresses them in the snapshot', async () => {
    const reader = await capturedSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!

    expect(source, 'the editor found nothing to cut in a recording it can play').not.toBeNull()
    // Three segments of the fixture, 48 frames apiece.
    expect(source.video.samples).toHaveLength(144)

    // Addressed where they lie in the snapshot and not from the first byte of a segment: the
    // index and the init stand in front of them, so a sample at zero would be the file's header.
    const first = source.video.samples[0]!.source
    expect(first.at).toBeGreaterThan(INIT.byteLength)
    const bytes = await reader.bytesOf(first)
    expect(bytes.byteLength).toBe(first.length)
  })

  it('cuts an ordinary complete file, where there are no fragments to walk', async () => {
    // The material most sites actually deliver. Left to the fragmented path this comes back null,
    // the Export button never leaves its disabled state, and the tab shows a preview of a
    // recording it will not write — which is what it did before this branch existed.
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!

    expect(source, 'the editor refused a file it has the tables of').not.toBeNull()
    expect(source.video.kind).toBe('video')
    expect(source.video.samples).toHaveLength(60)
    expect(source.audio, 'the sound of the file was left behind').toBeDefined()
  })

  it('takes the sound of a muxed buffer out of the picture\u2019s own segments', async () => {
    // One SourceBuffer for both kinds, which is the shape where the material has no sound track
    // to point at: the audio slot is empty and the sound is inside the picture's segments under
    // a track number of its own. Read as picture alone the recording exports silent, and there
    // is nothing on the screen to say so \u2014 the panel offers the clip and the file is mute.
    const reader = await muxedSnapshot()
    const material = materialOf(reader.index)

    expect(material.audio, 'the fixture has a sound track of its own to find').toBeNull()
    expect(material.video!.kinds).toEqual(['video', 'audio'])

    const source = (await openClipSource(reader, material))!
    expect(source.audio, 'the sound was left behind in the buffer it shares').toBeDefined()

    const asked = requests(source, [clip({ in: 1, out: 3 })])
    expect(copyPlan(asked[0]!).tracks.map((track) => track.kind)).toEqual(['video', 'audio'])

    const saved: Uint8Array[] = []
    const runner = createRunner({
      read: (at) => reader.bytesOf(at),
      encode: async () => null,
      save: async (file) => {
        saved.push(file)
      },
    })
    runner.enqueue(asked)
    await runner.settled()

    expect(runner.queue().jobs[0]!.state, runner.queue().jobs[0]!.error ?? '').toBe('done')
    // And it is in the file at the end of it, not merely in the plan.
    expect(parseInit(saved[0]!)!.tracks.map((track) => track.kind)).toEqual(['video', 'audio'])
  })

  it('cuts the same file out of a snapshot as it would out of the file standing alone', async () => {
    // The whole way down: the source, the plan, the reads the runner makes of the snapshot, the
    // writer. Comparing the result with itself would prove nothing — an address that forgot where
    // the file lies in the snapshot reads somebody else's bytes and still writes a file of the
    // right size and shape. So the answer is compared with the same cut of the same file read out
    // of the file itself, where the addresses are its own from the first byte.
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    const asked = clip({ in: 1, out: 3 })

    const saved: Uint8Array[] = []
    const runner = createRunner({
      read: (at) => reader.bytesOf(at),
      encode: async () => null,
      save: async (file) => {
        saved.push(file)
      },
    })
    runner.enqueue(requests(source, [asked]))
    await runner.settled()

    expect(runner.queue().jobs[0]!.state, runner.queue().jobs[0]!.error ?? '').toBe('done')

    const alone = clipSourceFrom(movieTracksOf(moovOf(WHOLE), WHOLE.byteLength))!
    const expected = assembleMp4(planOf(alone, asked), (at) =>
      WHOLE.subarray(at.at, at.at + at.length),
    )
    expect(expected.byteLength).toBeGreaterThan(1_000)
    expect(saved[0]).toEqual(expected)
  })

  it('opens a recording whose only track is the sound one', async () => {
    // Material with nothing in its picture slot: a file of sound alone fills the other one. The
    // tab has nothing to play and Export still has to work — the popup has offered to save such
    // a session since the capture stage, and the editor cannot be the one that refuses.
    const reader = await fileSnapshot()
    const material = materialOf(reader.index)

    expect(
      await openClipSource(reader, { ...material, video: null, audio: material.video }),
    ).not.toBeNull()
  })

  it('has nothing to cut when the snapshot holds no track at all', async () => {
    const reader = await capturedSnapshot()
    const material = materialOf(reader.index)

    expect(await openClipSource(reader, { ...material, video: null, audio: null })).toBeNull()
  })
})

describe('requestsFor', () => {
  it('names every file after its clip and numbers two clips named the same', async () => {
    const reader = await capturedSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!

    const asked = requests(source, [
      clip({ id: 'c1', name: 'Cats 01.23' }),
      clip({ id: 'c2', name: 'Dogs: 02.00' }),
      clip({ id: 'c3', name: 'Cats 01.23' }),
    ])

    expect(asked.map((one) => one.fileName)).toEqual([
      'Cats 01.23.mp4',
      'Dogs 02.00.mp4',
      'Cats 01.23 (2).mp4',
    ])
    expect(asked.map((one) => one.clipId)).toEqual(['c1', 'c2', 'c3'])
    // The plan on the request is the plan the estimate was made of, and not a second one.
    expect(copyPlan(asked[0]!).bytes).toBe(planOf(source, clip({ id: 'c1' })).bytes)
  })

  it('carries the sound switch of every clip into the plan it is written from', async () => {
    // The one setting of a clip that decides what goes into the file, and the estimate is made
    // of the same plan (Task 8): built with the switch nailed down, the editor writes silent
    // clips out of a recording that has sound in it and quotes the silent weight for both.
    const reader = await fileSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!
    expect(source.audio, 'the fixture has no sound to leave out').toBeDefined()

    const loud = planOf(source, clip({ sound: true }))
    const silent = planOf(source, clip({ sound: false }))

    expect(loud.tracks.map((track) => track.kind)).toEqual(['video', 'audio'])
    expect(silent.tracks.map((track) => track.kind)).toEqual(['video'])
    expect(silent.bytes).toBeLessThan(loud.bytes)

    // And it is that plan the runner is handed, clip by clip, rather than one built for the lot.
    const asked = requests(source, [
      clip({ id: 'c1', name: 'Loud', sound: true }),
      clip({ id: 'c2', name: 'Quiet', sound: false }),
    ])
    expect(asked.map((one) => copyPlan(one).tracks.map((track) => track.kind))).toEqual([
      ['video', 'audio'],
      ['video'],
    ])
  })

  it('plans what the clip asks for and not what the recording holds', async () => {
    const reader = await capturedSnapshot()
    const source = (await openClipSource(reader, materialOf(reader.index)))!

    const short = planOf(source, clip({ in: 1, out: 2 }))
    const long = planOf(source, clip({ in: 1, out: 5 }))

    expect(short.duration).toBeLessThan(long.duration)
    expect(short.bytes).toBeLessThan(long.bytes)
  })
})

describe('downloadIo', () => {
  afterEach(() => vi.unstubAllGlobals())

  const stubDownloads = (id: number | undefined) => {
    const asked: Array<{ url: string; filename: string }> = []
    vi.stubGlobal('chrome', {
      downloads: {
        download: (
          options: { url: string; filename: string },
          done: (id: number | undefined) => void,
        ) => {
          asked.push(options)
          done(id)
        },
      },
      runtime: { lastError: id === undefined ? { message: 'refused' } : undefined },
    })
    return asked
  }

  it('refuses re-encoding because this io only copies and downloads', async () => {
    await expect(
      downloadIo({} as SnapshotReader).encode({} as ExportRequest, () => undefined, () => false),
    ).rejects.toThrow(NO_ENCODER)
  })

  it('hands the file to the browser under the name the clip was given', async () => {
    const asked = stubDownloads(11)
    await downloadIo({} as SnapshotReader).save(new Uint8Array([1, 2, 3]), 'Cats.mp4')

    expect(asked).toHaveLength(1)
    expect(asked[0]!.filename).toBe('Cats.mp4')
    expect(asked[0]!.url).toMatch(/^blob:/)
  })

  it('lets the address outlive the call, so the download is not cut off halfway', async () => {
    // Chrome does not read the blob while `download` is running: it takes the address, answers
    // with an id, and comes back for the bytes afterwards. Revoked as the call returns, the
    // address is gone before the read \u2014 and what lands on disk is a part-written mp4 that no
    // player will open, with the row in the panel reading "Saved" over it.
    vi.useFakeTimers()
    const revoked: string[] = []
    const revoke = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation((url: string) => void revoked.push(url))

    try {
      const asked = stubDownloads(11)
      await downloadIo({} as SnapshotReader).save(new Uint8Array([1, 2, 3]), 'Cats.mp4')

      expect(revoked, 'the address was let go as the call returned').toEqual([])
      vi.advanceTimersByTime(10_000)
      expect(revoked, 'the address was let go ten seconds into the download').toEqual([])

      // And it is let go in the end: an address held for ever holds the whole file in memory
      // for as long as the tab is open, and a session is exported clip after clip.
      vi.advanceTimersByTime(60_000)
      expect(revoked).toEqual([asked[0]!.url])
    } finally {
      revoke.mockRestore()
      vi.useRealTimers()
    }
  })

  it('lets go at once of an address no download ever took', async () => {
    // The other side of the same wait. Nothing is reading this one, so there is nothing to cut
    // off, and holding it for a minute would pin a refused file in memory for no reason at all.
    vi.useFakeTimers()
    const revoked: string[] = []
    const revoke = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation((url: string) => void revoked.push(url))

    try {
      const asked = stubDownloads(undefined)
      await expect(
        downloadIo({} as SnapshotReader).save(new Uint8Array([1, 2, 3]), 'Cats.mp4'),
      ).rejects.toThrow(/refused to save/)

      vi.advanceTimersByTime(0)
      expect(revoked).toEqual([asked[0]!.url])
    } finally {
      revoke.mockRestore()
      vi.useRealTimers()
    }
  })

  it('leaves the browser to put the file where it always puts it', async () => {
    // The default of §9.4, and the one a queue of six clips needs: six dialogues for one press of
    // Export is not a setting anybody leaves on. `uniquify` is what keeps the sixth from writing
    // over the first when two clips of one page come out under one name.
    const asked = stubDownloads(11) as unknown as Array<Record<string, unknown>>
    await downloadIo({} as SnapshotReader).save(new Uint8Array([1]), 'Cats.mp4')

    expect(asked[0]!.saveAs).toBe(false)
    expect(asked[0]!.conflictAction).toBe('uniquify')
  })

  it('asks where every clip goes when the settings say to', async () => {
    const asked = stubDownloads(11) as unknown as Array<Record<string, unknown>>
    await downloadIo({} as SnapshotReader, { askWhere: true }).save(new Uint8Array([1]), 'Cats.mp4')

    expect(asked[0]!.saveAs).toBe(true)
  })

  it('says a clip was written, so that a recording cut from counts as used', async () => {
    // §7.3 puts a session the user cut from second only to what is pinned, and the editor is the
    // only place that knows a clip came out of one. Told after the browser took the file and not
    // before: a refused download is not a session anybody got anything out of.
    stubDownloads(11)
    const saved: number[] = []
    await downloadIo({} as SnapshotReader, { onSaved: () => saved.push(1) }).save(
      new Uint8Array([1]),
      'Cats.mp4',
    )

    expect(saved).toHaveLength(1)
  })

  it('says nothing of a clip the browser refused', async () => {
    stubDownloads(undefined)
    const saved: number[] = []

    await expect(
      downloadIo({} as SnapshotReader, { onSaved: () => saved.push(1) }).save(
        new Uint8Array([1]),
        'Cats.mp4',
      ),
    ).rejects.toThrow(/refused to save/)
    expect(saved).toEqual([])
  })

  it('fails the job when the browser refuses the download', async () => {
    // Chrome answers an id of undefined and says why in lastError. A promise that resolved here
    // would leave the row reading "Saved" over a file that was never written.
    stubDownloads(undefined)

    await expect(
      downloadIo({} as SnapshotReader).save(new Uint8Array([1, 2, 3]), 'Cats.mp4'),
    ).rejects.toThrow(/refused to save/)
  })
})
