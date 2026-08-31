import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { chunksOf } from '../../src/core/webp/riff'
import {
  clickEdit,
  exportClipWith,
  launchWithExtension,
  serveLocal,
  typeInto,
} from './helpers'

const PLAYER_URL = 'https://tailcut.test/webp'
const READER_URL = 'https://tailcut.test/webp-reader'
const WEBP_URL = 'https://tailcut.test/saved.webp'
const MOTION_URL = 'https://tailcut.test/motion.webp'
const MP4_URL = 'https://tailcut.test/original.mp4'
const EXPECTED_FRAMES = 100
const EXPECTED_DURATION_MS = 10_000
const CROP = { x: 6, y: 4, width: 120, height: 64 }

interface AnimationFacts {
  declared: number
  decoded: number
  durationMs: number
  width: number
  height: number
  cropDifference: number
  squashDifference: number
}

async function openTenSecondClip(): Promise<{ context: BrowserContext; editor: Page }> {
  const { context, extensionId } = await launchWithExtension()
  const player = await context.newPage()

  await serveLocal(player, 'minute.html', PLAYER_URL)
  await player.waitForFunction(
    () => (window as unknown as { tc?: { ready?: boolean; failure?: string | null } }).tc?.ready,
  )
  await player.evaluate(() => document.querySelector('video')!.play())
  await player.waitForFunction(() => document.querySelector('video')!.currentTime >= 8)

  const { editor } = await clickEdit(context, player, extensionId)
  await editor.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2)
  await typeInto(editor, 'playhead-field', '00:00:00:00')
  await editor.keyboard.press('i')
  await expect(editor.getByTestId('clip')).toHaveCount(1)
  await typeInto(editor, 'out-c1', '00:00:10:00')
  return { context, editor }
}

function riffFacts(file: string): { bytes: Uint8Array; loop: number; iccpFlag: number } {
  const fileBytes = readFileSync(file)
  const bytes = new Uint8Array(fileBytes.buffer, fileBytes.byteOffset, fileBytes.byteLength)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks = chunksOf(bytes)

  expect(8 + view.getUint32(4, true), 'the RIFF length leaves bytes outside the WebP').toBe(
    bytes.byteLength,
  )
  expect(
    fileBytes.includes(Buffer.from('ICCP')),
    'an ICC profile from a still survived inside the animation',
  ).toBe(false)
  expect([...new Set(chunks.map((chunk) => chunk.tag))]).toEqual(['VP8X', 'ANIM', 'ANMF'])

  const vp8x = chunks.filter((chunk) => chunk.tag === 'VP8X')
  const animation = chunks.filter((chunk) => chunk.tag === 'ANIM')
  expect(vp8x, 'the animation has no single VP8X header').toHaveLength(1)
  expect(animation, 'the animation has no single ANIM header').toHaveLength(1)

  return {
    bytes,
    iccpFlag: bytes[vp8x[0]!.at]! & 0x20,
    loop: view.getUint16(animation[0]!.at + 4, true),
  }
}

async function openReader(
  context: BrowserContext,
  webpFile: string,
  motionFile: string,
  originalFile: string,
): Promise<Page> {
  const page = await context.newPage()
  const [webp, motion, original] = await Promise.all([
    readFile(webpFile),
    readFile(motionFile),
    readFile(originalFile),
  ])

  await page.route(WEBP_URL, (route) => route.fulfill({ body: webp, contentType: 'image/webp' }))
  await page.route(MOTION_URL, (route) => route.fulfill({ body: motion, contentType: 'image/webp' }))
  await page.route(MP4_URL, (route) => route.fulfill({ body: original, contentType: 'video/mp4' }))
  await page.route(READER_URL, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><style>html,body{margin:0}img{display:block}</style>',
    }),
  )
  await page.goto(READER_URL)
  return page
}

async function readAnimation(page: Page): Promise<AnimationFacts> {
  return page.evaluate(
    async ({ webpUrl, mp4Url, crop, expectedFrames }) => {
      const difference = (left: Uint8ClampedArray, right: Uint8ClampedArray): number => {
        let total = 0
        for (let at = 0; at < left.length; at += 4) {
          total += Math.abs(left[at]! - right[at]!)
          total += Math.abs(left[at + 1]! - right[at + 1]!)
          total += Math.abs(left[at + 2]! - right[at + 2]!)
        }
        return total / ((left.length / 4) * 3)
      }

      const pixelsOf = (
        source: CanvasImageSource,
        from: { x: number; y: number; width: number; height: number },
      ): Uint8ClampedArray => {
        const canvas = document.createElement('canvas')
        canvas.width = crop.width
        canvas.height = crop.height
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('The browser gave no 2d context for the pixel oracle.')
        context.drawImage(
          source,
          from.x,
          from.y,
          from.width,
          from.height,
          0,
          0,
          crop.width,
          crop.height,
        )
        return context.getImageData(0, 0, crop.width, crop.height).data
      }

      const response = await fetch(webpUrl)
      if (!response.ok) throw new Error(`Reading the animation answered ${response.status}.`)
      const decoder = new ImageDecoder({
        data: await response.arrayBuffer(),
        type: 'image/webp',
        preferAnimation: true,
      })

      let declared = 0
      let decoded = 0
      let durationUs = 0
      let width = 0
      let height = 0
      let animatedPixels: Uint8ClampedArray | null = null

      try {
        await decoder.tracks.ready
        const track = decoder.tracks.selectedTrack
        if (!track) throw new Error('The animation has no selected image track.')
        declared = track.frameCount

        for (let frameIndex = 0; frameIndex < declared; frameIndex++) {
          const result = await decoder.decode({ frameIndex, completeFramesOnly: true })
          const frame = result.image
          try {
            if (!result.complete) throw new Error(`Frame ${frameIndex} is incomplete.`)
            if (frame.duration === null) throw new Error(`Frame ${frameIndex} has no duration.`)
            if (frameIndex === 0) {
              width = frame.displayWidth
              height = frame.displayHeight
              animatedPixels = pixelsOf(frame, {
                x: 0,
                y: 0,
                width: frame.displayWidth,
                height: frame.displayHeight,
              })
            } else if (frame.displayWidth !== width || frame.displayHeight !== height) {
              throw new Error(`Frame ${frameIndex} changed geometry.`)
            }
            durationUs += frame.duration
            decoded++
          } finally {
            frame.close()
          }
        }
      } finally {
        decoder.close()
      }

      if (!animatedPixels) throw new Error('The animation decoded no first frame.')
      if (declared !== expectedFrames) {
        // Keep the independent fixture oracle inside the browser result as well as in the test:
        // a decoder loop bounded by frameCount cannot prove on its own that no frames were thinned.
        throw new Error(`The animation declared ${declared} frames, expected ${expectedFrames}.`)
      }

      const video = document.createElement('video')
      video.muted = true
      video.playsInline = true
      video.style.position = 'fixed'
      video.style.left = '-10000px'
      document.body.append(video)

      try {
        const loaded = new Promise<void>((resolve, reject) => {
          video.addEventListener('loadeddata', () => resolve(), { once: true })
          video.addEventListener('error', () => reject(new Error('The Original MP4 did not load.')), {
            once: true,
          })
        })
        video.src = mp4Url
        await loaded

        const painted = new Promise<void>((resolve) =>
          video.requestVideoFrameCallback(() => resolve()),
        )
        const seeked = new Promise<void>((resolve) =>
          video.addEventListener('seeked', () => resolve(), { once: true }),
        )
        // The middle of the first 100 ms frame, the same landing rule the editor uses.
        video.currentTime = 0.05
        await Promise.all([painted, seeked])

        const croppedPixels = pixelsOf(video, crop)
        const squashedPixels = pixelsOf(video, {
          x: 0,
          y: 0,
          width: video.videoWidth,
          height: video.videoHeight,
        })

        return {
          declared,
          decoded,
          durationMs: durationUs / 1_000,
          width,
          height,
          cropDifference: difference(animatedPixels, croppedPixels),
          squashDifference: difference(animatedPixels, squashedPixels),
        }
      } finally {
        video.removeAttribute('src')
        video.load()
        video.remove()
      }
    },
    { webpUrl: WEBP_URL, mp4Url: MP4_URL, crop: CROP, expectedFrames: EXPECTED_FRAMES },
  )
}

async function distinctCompositorFrames(page: Page): Promise<number> {
  await page.bringToFront()
  await page.evaluate(async (url) => {
    const image = document.createElement('img')
    image.id = 'animation'
    image.src = url
    document.body.replaceChildren(image)
    await image.decode()
  }, MOTION_URL)

  const image = page.locator('#animation')
  await expect(image).toHaveJSProperty('naturalWidth', 256)
  await expect(image).toHaveJSProperty('naturalHeight', 144)

  const hashes = new Set<string>()
  const started = Date.now()
  for (let index = 0; index < 20; index++) {
    const due = started + (index * 5_000) / 19
    await page.waitForTimeout(Math.max(0, due - Date.now()))
    const screenshot = await image.screenshot({ animations: 'allow' })
    hashes.add(createHash('sha256').update(screenshot).digest('hex'))
  }
  return hashes.size
}

test('writes the selected crop as a silent animated WebP at the source pace', async () => {
  test.setTimeout(240_000)
  const { context, editor } = await openTenSecondClip()

  try {
    const original = await exportClipWith(editor, { format: 'mp4' })

    const animated = await exportClipWith(editor, {
      format: 'webp',
      crop: { x: 7, y: 5, width: 121, height: 65 },
      beforeExport: async (configured) => {
        await expect(configured.getByTestId('crop-geometry')).toHaveText('120 × 64')
        await expect(configured.getByTestId('format-c1')).toHaveValue('webp')
        await expect(configured.getByTestId('sound-c1')).toBeDisabled()
        await expect(configured.getByTestId('sound-c1')).not.toBeChecked()
      },
    })

    // Keep the compositor oracle apart from the crop oracle. This deliberately sparse fixture
    // has only eight distinct decoded pictures even without a crop, and the selected top 64 rows
    // hide its moving box for much of the loop; the whole frame gives the compositor every change
    // the source has instead of pricing which changes happen to cross the selected rectangle.
    await editor.getByTestId('crop-reset').click()
    const moving = await exportClipWith(editor, {
      format: 'webp',
      beforeExport: async (configured) => {
        await expect(configured.getByTestId('crop-geometry')).toHaveText('256 × 144')
        await expect(configured.getByTestId('sound-c1')).toBeDisabled()
        await expect(configured.getByTestId('sound-c1')).not.toBeChecked()
      },
    })

    expect(animated.name).toMatch(/\.webp$/)

    const riff = riffFacts(animated.file)
    expect(riff.iccpFlag, 'VP8X claims an ICC profile that the file does not carry').toBe(0)
    expect(riff.loop, 'the animation does not repeat forever').toBe(0)

    const reader = await openReader(context, animated.file, moving.file, original.file)
    const facts = await readAnimation(reader)
    expect(facts.declared).toBe(EXPECTED_FRAMES)
    expect(facts.decoded).toBe(EXPECTED_FRAMES)
    expect(Math.abs(facts.durationMs - EXPECTED_DURATION_MS)).toBeLessThanOrEqual(1)
    expect([facts.width, facts.height]).toEqual([CROP.width, CROP.height])

    console.log(
      `WebP first-frame mean RGB difference: crop=${facts.cropDifference.toFixed(3)}, squash=${facts.squashDifference.toFixed(3)}`,
    )
    expect(facts.cropDifference).toBeLessThan(facts.squashDifference)
    const motion = await distinctCompositorFrames(reader)
    console.log(`WebP compositor motion: ${motion} distinct screenshots`)
    // Measured twice over the real animation: six and seven. Repeating the first still gave one.
    // Four is the empty space between those populations, not a demand this sparse fixture cannot
    // meet: even the uncropped source contains only eight distinct decoded pictures in ten seconds.
    expect(motion).toBeGreaterThan(4)
  } finally {
    await context.close()
  }
})
