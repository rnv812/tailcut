import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import {
  clickEdit,
  exportClipWith,
  launchWithExtension,
  serveLocal,
  typeInto,
} from './helpers'

const PLAYER_URL = 'https://tailcut.test/encode-cost'

interface CodecProbe {
  decoderCalls: number
  decoderMax: number
  encoderCalls: number
  encoderMax: number
  raf?: {
    elapsedMs: number
    hidden: boolean
    last: number
    running: boolean
    started: number
    ticks: number
    worstGapMs: number
  }
}

interface MinuteState {
  ready: boolean
  failure: string | null
  appended: { video: number[]; audio: number[] }
}

interface OpenedMinute {
  context: BrowserContext
  editor: Page
}

/** Record the queue sizes Chrome reports immediately after accepting real codec work. */
async function installProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const state: CodecProbe = {
      decoderCalls: 0,
      decoderMax: 0,
      encoderCalls: 0,
      encoderMax: 0,
    }
    Object.defineProperty(globalThis, 'tcEncodeCost', {
      configurable: true,
      value: state,
    })

    const decode = VideoDecoder.prototype.decode
    VideoDecoder.prototype.decode = function (chunk: EncodedVideoChunk): void {
      decode.call(this, chunk)
      state.decoderCalls += 1
      state.decoderMax = Math.max(state.decoderMax, this.decodeQueueSize)
    }

    const encode = VideoEncoder.prototype.encode
    VideoEncoder.prototype.encode = function (
      frame: VideoFrame,
      options?: VideoEncoderEncodeOptions,
    ): void {
      encode.call(this, frame, options)
      state.encoderCalls += 1
      state.encoderMax = Math.max(state.encoderMax, this.encodeQueueSize)
    }
  })
}

const probeIn = (editor: Page): Promise<CodecProbe> =>
  editor.evaluate(() => ({ ...(globalThis as unknown as { tcEncodeCost: CodecProbe }).tcEncodeCost }))

async function resetProbe(editor: Page): Promise<void> {
  await editor.evaluate(() => {
    const state = (globalThis as unknown as { tcEncodeCost: CodecProbe }).tcEncodeCost
    state.decoderCalls = 0
    state.decoderMax = 0
    state.encoderCalls = 0
    state.encoderMax = 0
    delete state.raf
  })
}

/** Start on a painted frame so a freeze immediately after Export is part of the measurement. */
async function startFrames(editor: Page): Promise<void> {
  await editor.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const state = (globalThis as unknown as { tcEncodeCost: CodecProbe }).tcEncodeCost
        const raf = {
          elapsedMs: 0,
          hidden: document.visibilityState !== 'visible',
          last: 0,
          running: true,
          started: 0,
          ticks: 0,
          worstGapMs: 0,
        }
        state.raf = raf

        const tick = (now: number): void => {
          if (!raf.running) return
          if (raf.ticks === 0) {
            raf.started = now
            resolve()
          } else {
            raf.worstGapMs = Math.max(raf.worstGapMs, now - raf.last)
          }
          raf.hidden ||= document.visibilityState !== 'visible'
          raf.last = now
          raf.ticks += 1
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
}

/** Include the tail after the last callback: that is where one long final task would otherwise hide. */
async function stopFrames(editor: Page): Promise<CodecProbe> {
  return editor.evaluate(() => {
    const state = (globalThis as unknown as { tcEncodeCost: CodecProbe }).tcEncodeCost
    const raf = state.raf!
    const now = performance.now()
    raf.worstGapMs = Math.max(raf.worstGapMs, now - raf.last)
    raf.elapsedMs = now - raf.started
    raf.hidden ||= document.visibilityState !== 'visible'
    raf.running = false
    return { ...state, raf: { ...raf } }
  })
}

/** Capture every segment once; playback is accelerated because capture is not what this test times. */
async function openMinute(): Promise<OpenedMinute> {
  const { context, extensionId } = await launchWithExtension()
  await installProbe(context)
  const player = await context.newPage()
  await serveLocal(player, 'minute.html', PLAYER_URL)
  await player.waitForFunction(() => {
    const state = (globalThis as unknown as { tc?: MinuteState }).tc
    return state?.ready === true || state?.failure != null
  })
  expect(
    await player.evaluate(() => (globalThis as unknown as { tc: MinuteState }).tc.failure),
  ).toBeNull()
  await player.evaluate(async () => {
    const video = document.querySelector('video')!
    video.playbackRate = 4
    await video.play()
  })
  await player.waitForFunction(
    () => {
      const state = (globalThis as unknown as { tc: MinuteState }).tc
      return state.failure != null ||
        (state.appended.video.length === 10 && state.appended.audio.length === 12)
    },
    undefined,
    { timeout: 30_000 },
  )
  const captured = await player.evaluate(
    () => (globalThis as unknown as { tc: MinuteState }).tc,
  )
  expect(captured.failure).toBeNull()
  expect(captured.appended.video).toHaveLength(10)
  expect(captured.appended.audio).toHaveLength(12)

  const { editor } = await clickEdit(context, player, extensionId)
  await player.close()
  await editor.bringToFront()
  await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
  expect(await editor.evaluate(() => document.visibilityState)).toBe('visible')
  expect(await editor.evaluate(() => typeof VideoEncoder.isConfigSupported)).toBe('function')

  await typeInto(editor, 'playhead-field', '00:00:00:00')
  await editor.keyboard.press('i')
  await expect(editor.getByTestId('clip')).toHaveCount(1)
  return { context, editor }
}

test('keeps the visible editor painting while real codecs consume a minute', async () => {
  test.setTimeout(240_000)
  const { context, editor } = await openMinute()

  try {
    await typeInto(editor, 'out-c1', '00:00:10:00')
    await resetProbe(editor)
    const tenStarted = Date.now()
    await exportClipWith(editor, { encode: true, timeoutMs: 180_000 })
    const ten = await probeIn(editor)
    console.log('encode-cost 10 seconds', { ...ten, elapsedMs: Date.now() - tenStarted })

    await typeInto(editor, 'out-c1', '00:01:00:00')
    await resetProbe(editor)
    await startFrames(editor)
    const minuteStarted = Date.now()
    await exportClipWith(editor, { encode: true, timeoutMs: 180_000 })
    const minute = await stopFrames(editor)
    console.log('encode-cost 60 seconds', { ...minute, elapsedMs: Date.now() - minuteStarted })

    // These are the work the two labels promise, not queue bounds inferred from empty readings.
    expect(ten.decoderCalls).toBe(100)
    expect(ten.encoderCalls).toBe(100)
    expect(minute.decoderCalls).toBe(600)
    expect(minute.encoderCalls).toBe(600)
    expect(minute.raf?.hidden).toBe(false)
    expect(minute.raf?.ticks).toBeGreaterThan(1)
    expect(minute.raf?.worstGapMs).toBeLessThan(500)
    expect(await editor.evaluate(() => document.visibilityState)).toBe('visible')
  } finally {
    await context.close()
  }
})
