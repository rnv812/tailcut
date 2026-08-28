import { test, expect } from '@playwright/test'
import {
  inspectFile,
  launchWithExtension,
  openPopupOn,
  playInBrowser,
  playThroughMse,
  routeLocal,
  saveAll,
  type FileFacts,
} from './helpers'

/**
 * The rows of this file stay on one worker, alone among the specs of the suite.
 *
 * What is produced here is a table, printed whole in `afterAll` — which combination came out how
 * heavy, how long, and with what said about it by a reader and by a decoder. `afterAll` runs once
 * per worker, so a file spread over the pool prints a piece of the table per worker, each with
 * its own heading and none of them the matrix.
 *
 * Eight rows of twenty seconds in a row is 164 s, which is longer than everything else the pool
 * has to get through, so the whole run is as long as this file: measured at 170 s pinned against
 * 163 s spread. Seven seconds is what the table costs.
 */
test.describe.configure({ mode: 'default' })

const PLAYER_URL = 'https://tailcut.test/codecs'

/**
 * How long the player has to run for triage to let it through the probation period
 * (BALANCED.gracePeriodSeconds = 6). A second of slack for the polling of the watcher.
 */
const PLAY_MS = 7_000

/** Real-time playback of the saved clip, twice over, on top of everything else a row does. */
const TIMEOUT_MS = 180_000

type PageState = { allAppended?: boolean; failure?: string | null; unsupported?: string | null }

/** One SourceBuffer of the page under test: the type it is opened with and what goes into it. */
interface Feed {
  mime: string
  init: string
  chunks: string[]
}

const numbered = (dir: string, stream: number, count: number, ext: string): string[] =>
  Array.from(
    { length: count },
    (_, i) => `/fixtures/${dir}/chunk-stream${stream}-0000${i + 1}.${ext}`,
  )

/** Picture in fragmented mp4, H.264 — the codec most of the web still serves. */
const H264: Feed = {
  mime: 'video/mp4; codecs="avc1.4d401e"',
  init: '/fixtures/h264/init-stream0.m4s',
  chunks: numbered('h264', 0, 3, 'm4s'),
}

/** Sound in fragmented mp4, AAC — the other half of the classic pairing. */
const AAC: Feed = {
  mime: 'audio/mp4; codecs="mp4a.40.2"',
  init: '/fixtures/h264/init-stream1.m4s',
  chunks: numbered('h264', 1, 4, 'm4s'),
}

/**
 * Picture in fragmented mp4, AV1 — what YouTube served in the last run against the real site. An
 * mp4 the ISO reader has never seen the sample entry of, which is the point: nothing above the
 * container is supposed to know one four-letter code from another.
 */
const AV1: Feed = {
  mime: 'video/mp4; codecs="av01.0.00M.08"',
  init: '/fixtures/av1/init-stream0.m4s',
  chunks: numbered('av1', 0, 3, 'm4s'),
}

/**
 * Picture in WebM, VP9 — what YouTube serves when AV1 is not on offer. Declared in the full form,
 * fields and all: Matroska carries none of what a vp09 sample entry has to state, and the codec
 * string carries all of it.
 */
const VP9: Feed = {
  mime: 'video/webm; codecs="vp09.00.10.08"',
  init: '/fixtures/webm/init-stream0.webm',
  chunks: numbered('webm', 0, 3, 'webm'),
}

/** Sound in WebM, Opus — what YouTube serves with either picture. */
const OPUS: Feed = {
  mime: 'audio/webm; codecs="opus"',
  init: '/fixtures/webm/init-stream1.webm',
  chunks: numbered('webm', 1, 4, 'webm'),
}

interface Case {
  name: string
  feeds: Feed[]
  /** [codec_type, codec_name] per stream, in the order the file must hold them. */
  streams: Array<[string, string]>
  /** Frames of each of those streams, all of the material the page loaded. */
  frames: number[]
  /** What the popup offers before the button is pressed. */
  offered: string
  /** The band the length of the file has to fall in. */
  seconds: [number, number]
  /** Sound tracks a browser must find in the file. */
  audioTracks: number
  /** Frame size a browser must find; null for a file with no picture in it. */
  frameSize: [number, number] | null
  /** The type the file is offered back to Media Source Extensions under. */
  mseType: string
}

/**
 * Every arrangement of codecs and containers a site may hand over, saved through the real popup
 * and read back off disk.
 *
 * Which codec a site serves is not the user's choice and not ours: it turns on the machine, the
 * browser build and what the site happens to have encoded. So the question this answers is not
 * whether one path works but whether all of them do — the classic mp4 pairing, the two YouTube
 * serves in practice, the two containers crossed the other way round, and a stream that has only
 * one kind of media in it at all. Each row is checked the same way, and the numbers are printed
 * as a table at the end of the run.
 */
const CASES: Case[] = [
  {
    name: 'h264 (mp4) + aac (mp4)',
    feeds: [H264, AAC],
    streams: [
      ['video', 'h264'],
      ['audio', 'aac'],
    ],
    // 144 frames of picture at 24 a second, and 260 frames of sound of 1024 samples at 44100.
    frames: [144, 260],
    offered: '0:06',
    seconds: [5.9, 6.1],
    audioTracks: 1,
    frameSize: [320, 240],
    mseType: 'video/mp4; codecs="avc1.4d401e,mp4a.40.2"',
  },
  {
    name: 'av1 (mp4) + opus (webm)',
    feeds: [AV1, OPUS],
    streams: [
      ['video', 'av1'],
      ['audio', 'opus'],
    ],
    // 60 frames of picture at 10 a second, and 300 Opus packets of 20 milliseconds each.
    frames: [60, 300],
    offered: '0:06',
    seconds: [5.9, 6.1],
    audioTracks: 1,
    frameSize: [256, 144],
    mseType: 'video/mp4; codecs="av01.0.00M.08,opus"',
  },
  {
    name: 'vp9 (webm) + opus (webm)',
    feeds: [VP9, OPUS],
    streams: [
      ['video', 'vp9'],
      ['audio', 'opus'],
    ],
    frames: [60, 300],
    offered: '0:06',
    seconds: [5.9, 6.1],
    audioTracks: 1,
    frameSize: [256, 144],
    mseType: 'video/mp4; codecs="vp09.00.10.08,opus"',
  },
  {
    name: 'vp9 (webm) + aac (mp4)',
    feeds: [VP9, AAC],
    streams: [
      ['video', 'vp9'],
      ['audio', 'aac'],
    ],
    frames: [60, 260],
    offered: '0:06',
    // The picture starts a hundredth of a second in and the sound a hundredth before it runs out:
    // whole segments reach the file, so it is a shade longer than the stretch they were cut over.
    seconds: [5.9, 6.2],
    audioTracks: 1,
    frameSize: [256, 144],
    mseType: 'video/mp4; codecs="vp09.00.10.08,mp4a.40.2"',
  },
  {
    name: 'h264 (mp4), no sound',
    feeds: [H264],
    streams: [['video', 'h264']],
    frames: [144],
    offered: '0:06',
    seconds: [5.9, 6.1],
    audioTracks: 0,
    frameSize: [320, 240],
    mseType: 'video/mp4; codecs="avc1.4d401e"',
  },
  {
    name: 'aac (mp4), no picture',
    feeds: [AAC],
    streams: [['audio', 'aac']],
    frames: [260],
    offered: '0:06',
    seconds: [5.9, 6.1],
    audioTracks: 1,
    frameSize: null,
    mseType: 'audio/mp4; codecs="mp4a.40.2"',
  },
  {
    name: 'vp9 (webm), no sound',
    feeds: [VP9],
    streams: [['video', 'vp9']],
    frames: [60],
    offered: '0:06',
    seconds: [5.9, 6.1],
    audioTracks: 0,
    frameSize: [256, 144],
    mseType: 'video/mp4; codecs="vp09.00.10.08"',
  },
  {
    name: 'opus (webm), no picture',
    feeds: [OPUS],
    streams: [['audio', 'opus']],
    frames: [300],
    offered: '0:06',
    seconds: [5.9, 6.1],
    audioTracks: 1,
    frameSize: null,
    mseType: 'audio/mp4; codecs="opus"',
  },
]

/** One line of the table printed at the end of the run. */
interface Row {
  name: string
  facts: FileFacts
  playedToEnd: boolean
  playbackError: string | null
  audioTracks: number | null
  mseAccepted: boolean
}

const rows: Row[] = []

for (const scenario of CASES) {
  test(`a clip of ${scenario.name} saves as a file that plays`, async () => {
    test.setTimeout(TIMEOUT_MS)

    const { context, extensionId } = await launchWithExtension()
    const page = await context.newPage()
    await routeLocal(page, 'codecs.html', PLAYER_URL)
    // The feeds travel in the fragment, which is not sent to the network and so does not disturb
    // the routing above.
    await page.goto(`${PLAYER_URL}#${encodeURIComponent(JSON.stringify(scenario.feeds))}`)

    await page.waitForFunction(
      () => {
        const state = window as unknown as PageState
        return state.allAppended === true || state.failure != null || state.unsupported != null
      },
      undefined,
      { timeout: 15_000 },
    )

    const state = await page.evaluate(() => {
      const page = window as unknown as PageState
      return { failure: page.failure ?? null, unsupported: page.unsupported ?? null }
    })
    // A browser without the decoder is not a defect of the extension, and reporting it as one
    // would be worse than reporting nothing: the row would claim to have tested a combination the
    // browser never played.
    expect(
      state.unsupported,
      `this browser does not offer ${state.unsupported} at all, so the combination is untested`,
    ).toBeNull()
    expect(state.failure).toBeNull()

    await page.evaluate(() => document.querySelector('video')!.play())
    await page.waitForTimeout(PLAY_MS)

    const popup = await openPopupOn(context, page, extensionId)
    await expect(popup.getByTestId('duration')).toHaveText(scenario.offered)

    const file = await saveAll(page, popup)
    const facts = inspectFile(file)

    // A browser of its own, without the extension: what is under test is the file.
    const played = await playInBrowser(file)
    // And back in through the door it came out of. A file a browser will play is not yet a file a
    // browser will parse: MSE reads the boxes and refuses a sample entry that does not describe
    // its track, where the ordinary playback path reads the frames instead and never notices.
    const remuxed = await playThroughMse(file, scenario.mseType)

    rows.push({
      name: scenario.name,
      facts,
      playedToEnd: played.ended,
      playbackError: played.error,
      audioTracks: played.audioTracks,
      mseAccepted: remuxed.appended && remuxed.ended,
    })

    await context.close()

    expect(facts.probeStatus, facts.probeStderr).toBe(0)
    expect(facts.probeStderr, 'ffprobe complains about reading the saved file').toBe('')
    expect(facts.streams.map((s) => [s.codec_type, s.codec_name])).toEqual(scenario.streams)
    expect(facts.streams.map((s) => Number(s.nb_read_frames))).toEqual(scenario.frames)
    expect(facts.duration).toBeGreaterThan(scenario.seconds[0])
    expect(facts.duration).toBeLessThan(scenario.seconds[1])

    // Read through by a decoder and not only by a parser: material described wrongly gets past
    // the headers and past a frame count, and turns into words on stderr only here.
    expect(facts.decodeStatus, facts.decodeStderr).toBe(0)
    expect(facts.decodeStderr, 'decoding the saved file produces warnings').toBe('')

    expect(played.error).toBeNull()
    expect(played.ended, 'playback did not reach the end of the clip').toBe(true)
    expect(played.duration).toBeGreaterThan(scenario.seconds[0])
    expect(played.reached).toBeGreaterThan(scenario.seconds[0] - 0.5)
    // The browser found the sound and decoded it. A file whose audio it could not make sense of
    // would still open, still report a duration and still run to the end — in silence.
    expect(played.audioTracks).toBe(scenario.audioTracks)
    expect(played.audioBytes > 0).toBe(scenario.audioTracks > 0)

    if (scenario.frameSize) {
      expect(played.videoBytes, 'the browser decoded no picture at all').toBeGreaterThan(0)
      // A frame off the element and into a canvas. Bytes going into a decoder are not pixels
      // coming out of one: a file the browser opens, sizes and runs to the end can still show a
      // blank field the whole way through.
      expect(played.frameError).toBeNull()
      expect([played.frameWidth, played.frameHeight]).toEqual(scenario.frameSize)
      expect(played.frameColours, 'the browser drew a blank frame').toBeGreaterThan(1)
    } else {
      expect(played.videoBytes, 'a file with no picture decoded one').toBe(0)
      expect(played.frameWidth, 'a file with no picture reported a frame size').toBe(0)
    }

    expect(remuxed.error).toBeNull()
    expect(remuxed.supported, `the browser does not offer ${scenario.mseType} at all`).toBe(true)
    expect(remuxed.appended, 'Media Source Extensions refused the saved file').toBe(true)
    expect(remuxed.ended, 'the saved file did not play through as a media source').toBe(true)
    if (scenario.frameSize) expect([remuxed.width, remuxed.height]).toEqual(scenario.frameSize)
  })
}

/**
 * The matrix as one table. Printed rather than asserted: every number in it already has an
 * assertion of its own above, and what the table is for is the run that has to be read by a
 * person — which combination came out how heavy, how long, and with what said about it.
 */
test.afterAll(() => {
  if (!rows.length) return

  const line = (row: Row): string => {
    const streams = row.facts.streams
      .map((s) => `${s.codec_name} ${s.nb_read_frames}f`)
      .join(' + ')
    const complaints = [row.facts.probeStderr, row.facts.decodeStderr]
      .map((text) => text.trim().replace(/\s+/g, ' ') || 'none')
      .join(' / ')

    return [
      row.name,
      `${row.facts.bytes} B`,
      streams || 'none',
      row.facts.duration.toFixed(3),
      complaints,
      row.playedToEnd ? `yes (${row.audioTracks} audio)` : `no (${row.playbackError})`,
      row.mseAccepted ? 'yes' : 'no',
    ].join(' | ')
  }

  console.log(
    [
      '',
      'case | size | streams | duration | ffprobe / ffmpeg | plays to end | MSE',
      '--- | --- | --- | --- | --- | --- | ---',
      ...rows.map(line),
      '',
    ].join('\n'),
  )
})
