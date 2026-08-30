import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ladderFor, type Rung } from '../../src/core/encode/codec'

// The implementation is an executable ESM tool. TypeScript does not derive declarations from
// `.mjs`; the behavioral contract below is the declaration that matters for this internal tool.
// @ts-expect-error No declaration file exists for the executable module.
const windowsCheck = await import('../../tools/windows-check.mjs')
const {
  assertSafeRunRoot,
  assertWatchedOut,
  armDownloadCapture,
  buildLadderBundle,
  chromeLaunchArgs,
  closeAttachedBrowser,
  codecForEditor,
  completedDownloadPath,
  completedDownload,
  countBFrames,
  createMediaServer,
  defaultWindowsPaths,
  downloadBehavior,
  decodeWebp,
  driveWatchedMedia,
  enableDownloads,
  exportPlan,
  ffmpegDecodeCommand,
  ffprobeExportCommand,
  ffprobeCommand,
  generateMinuteCommand,
  inspectDownloadedArtifact,
  probeMatrix,
  probeMatrixFromBundle,
  rangedResponse,
  runExports,
  runWindowsCheck,
  startBrowserSession,
  stampExtensionIdentity,
  toWindowsPath,
  validateExport,
  validateInput,
  exportProbeFacts,
  verifyDownloadIdentity,
  verifyExtensionIdentity,
  waitForDownload,
} = windowsCheck

type InputProbe = {
  duration: number
  streams: Array<{
    type: 'video' | 'audio'
    width?: number
    height?: number
    fps?: number
  }>
}

type Mp4Probe = {
  width: number
  height: number
  duration: number
  hasAudio: boolean
  codec: string
  selectedChoice: string
  level?: number
  firstVideoPts: number
  videoStart: number
  audioStart: number
  bFrames: number
  decoded: boolean
}

type DownloadEvent =
  | {
      method: 'Browser.downloadWillBegin'
      params: { guid: string; suggestedFilename: string; url?: string }
    }
  | {
      method: 'Browser.downloadProgress'
      params: {
        guid: string
        state: 'inProgress' | 'completed' | 'canceled'
        filePath?: string
      }
    }

const inputProbe = (over: Partial<InputProbe> = {}): InputProbe => ({
  duration: 60.04,
  streams: [
    { type: 'video', width: 1920, height: 1080, fps: 30 },
    { type: 'audio' },
  ],
  ...over,
})

const mp4Probe = (over: Partial<Mp4Probe> = {}): Mp4Probe => ({
  width: 1920,
  height: 1080,
  duration: 60.01,
  hasAudio: true,
  codec: 'hevc',
  selectedChoice: 'HEVC in hardware',
  firstVideoPts: 0,
  videoStart: 0,
  audioStart: 0.01,
  bFrames: 42,
  decoded: true,
  ...over,
})

describe('Windows and working paths', () => {
  it('uses a generic Windows account placeholder when USER is unavailable', () => {
    vi.stubEnv('USER', '')

    try {
      const defaults = defaultWindowsPaths()

      expect(defaults.tempWsl).toBe('/mnt/c/Users/user/AppData/Local/Temp')
      expect(defaults.windowsTemp).toBe('C:\\Users\\user\\AppData\\Local\\Temp')
      expect(defaults.chrome).toBe(
        '/mnt/c/Users/user/AppData/Local/Temp/tailcut-probe/cft/chrome-win64/chrome.exe',
      )
      expect(defaults.workRoot).toMatch(
        /^\/mnt\/c\/Users\/user\/AppData\/Local\/Temp\/tailcut\/[^/]+$/,
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('translates only a mounted drive path into a native Windows path', () => {
    expect(toWindowsPath('/mnt/c/Users/alice/AppData/Local/Temp/tailcut/run-42/downloads')).toBe(
      'C:\\Users\\alice\\AppData\\Local\\Temp\\tailcut\\run-42\\downloads',
    )
    expect(toWindowsPath('/mnt/d/video/source.mp4')).toBe('D:\\video\\source.mp4')

    expect(() => toWindowsPath('/home/alice/source.mp4')).toThrow(/\/mnt\/<drive>/i)
    expect(() => toWindowsPath('\\\\wsl.localhost\\Ubuntu\\tmp\\source.mp4')).toThrow(/UNC/i)
    expect(() => toWindowsPath('/mnt/cc/source.mp4')).toThrow(/\/mnt\/<drive>/i)
  })

  it('accepts one unique run below Temp and rejects broad roots', () => {
    const temp = 'C:\\Users\\alice\\AppData\\Local\\Temp'
    expect(() =>
      assertSafeRunRoot(`${temp}\\tailcut\\20260830-7f34`, temp),
    ).not.toThrow()

    for (const broad of [
      'C:\\',
      temp,
      `${temp}\\tailcut`,
      'C:\\Users\\alice',
      'D:\\work\\tailcut\\run-1',
    ]) {
      expect(() => assertSafeRunRoot(broad, temp), broad).toThrow(/run|root|Temp/i)
    }
  })
})

describe('the real codec ladder matrix', () => {
  it('asks the supplied ladder for three real rungs at eight geometries', () => {
    const calls: Array<{ width: number; height: number; framerate: number }> = []
    const traced = (
      geometry: { width: number; height: number; framerate: number },
      options: { codec: 'hevc'; quality: 'high' },
    ): Rung[] => {
      calls.push(geometry)
      return ladderFor(geometry, options)
    }

    const rows = probeMatrix(traced)

    expect(calls).toEqual([
      { width: 640, height: 360, framerate: 30 },
      { width: 640, height: 360, framerate: 60 },
      { width: 1280, height: 720, framerate: 30 },
      { width: 1280, height: 720, framerate: 60 },
      { width: 1920, height: 1080, framerate: 30 },
      { width: 1920, height: 1080, framerate: 60 },
      { width: 3840, height: 2160, framerate: 30 },
      { width: 3840, height: 2160, framerate: 60 },
    ])
    expect(rows).toHaveLength(24)
    for (const geometry of calls) {
      const atGeometry = rows.filter(
        (row: { width: number; height: number; framerate: number }) =>
          row.width === geometry.width &&
          row.height === geometry.height &&
          row.framerate === geometry.framerate,
      )
      expect(
        atGeometry.map((row: { kind: string }) => row.kind),
        `${geometry.width}x${geometry.height}@${geometry.framerate}`,
      ).toEqual(['hevc-hw', 'h264-hw', 'h264-sw'])
    }
  })

  it('does not replace the supplied bundle with its own table', () => {
    const sentinel = vi.fn(
      (geometry: { width: number; height: number; framerate: number }): Rung[] => [
        {
          config: {
            codec: `sentinel-${geometry.width}`,
            width: geometry.width,
            height: geometry.height,
            framerate: geometry.framerate,
          },
          choice: {
            kind: 'h264-sw',
            config: {
              codec: `sentinel-${geometry.width}`,
              width: geometry.width,
              height: geometry.height,
              framerate: geometry.framerate,
            },
            control: 'fixed-bitrate',
            bitrate: 1,
          },
        },
      ],
    )

    const rows = probeMatrix(sentinel)

    expect(sentinel).toHaveBeenCalledTimes(8)
    expect(rows).toHaveLength(8)
    expect(rows[0].config.codec).toBe('sentinel-640')
  })

  it('loads ladderFor from the bundle before it builds any rows', async () => {
    const bundledLadder = vi.fn(
      (geometry: { width: number; height: number; framerate: number }): Rung[] =>
        ladderFor(geometry, { codec: 'hevc', quality: 'high' }),
    )
    const bundle = vi.fn(async (request: { module: string; export: string }) => {
      expect(request.module).toMatch(/src\/core\/encode\/codec\.ts$/)
      expect(request.export).toBe('ladderFor')
      return bundledLadder
    })

    const rows = await probeMatrixFromBundle(bundle)

    expect(bundle).toHaveBeenCalledTimes(1)
    expect(bundledLadder).toHaveBeenCalledTimes(8)
    expect(rows).toHaveLength(24)
  })

  it('builds and executes the real ladder as a self-contained browser script', async () => {
    const bundle = await buildLadderBundle()
    const browserGlobal: { tailcutLadderFor?: typeof ladderFor } = {}

    expect(bundle.inputs.some((input: string) => input.endsWith('src/core/encode/codec.ts'))).toBe(
      true,
    )
    expect(bundle.script).not.toMatch(/\bimport\s/)
    new Function('globalThis', bundle.script)(browserGlobal)

    expect(browserGlobal.tailcutLadderFor).toBeTypeOf('function')
    expect(probeMatrix(browserGlobal.tailcutLadderFor)).toEqual(probeMatrix(ladderFor))
  })
})

describe('media preparation and validation', () => {
  it('builds a self-contained minute with 1080p30 H.264 and AAC', () => {
    const command = generateMinuteCommand('/tmp/run/media/minute.mp4')
    const line = command.join(' ')

    expect(command[0]).toBe('ffmpeg')
    expect(line).toContain('testsrc2=size=1920x1080:rate=30')
    expect(line).toContain('sine=frequency=1000:sample_rate=48000')
    expect(line).toMatch(/-t 60(?:\.0+)?(?: |$)/)
    expect(line).toMatch(/-c:v (?:libx264|h264)/)
    expect(line).toContain('-c:a aac')
    expect(command.at(-1)).toBe('/tmp/run/media/minute.mp4')
  })

  it('asks ffprobe for streams and format as JSON and fully decodes the same file', () => {
    expect(ffprobeCommand('/tmp/input.mp4')).toEqual([
      'ffprobe',
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      '/tmp/input.mp4',
    ])
    expect(ffmpegDecodeCommand('/tmp/input.mp4')).toEqual([
      'ffmpeg',
      '-v',
      'error',
      '-i',
      '/tmp/input.mp4',
      '-f',
      'null',
      '-',
    ])
  })

  it('requires a decodable 1080p minute with picture and sound', () => {
    expect(() => validateInput('1080', inputProbe(), { status: 0 })).not.toThrow()

    expect(() => validateInput('1080', inputProbe({ duration: 59.99 }), { status: 0 })).toThrow(
      /60 seconds/i,
    )
    expect(() =>
      validateInput(
        '1080',
        inputProbe({ streams: [{ type: 'video', width: 256, height: 144, fps: 30 }] }),
        { status: 0 },
      ),
    ).toThrow(/1920.*1080/i)
    expect(() =>
      validateInput(
        '1080',
        inputProbe({ streams: [{ type: 'video', width: 1920, height: 1080, fps: 30 }] }),
        { status: 0 },
      ),
    ).toThrow(/audio|sound/i)
    expect(() => validateInput('1080', inputProbe(), { status: 1 })).toThrow(/decode/i)
  })

  it('requires real 4K30, sound, ten seconds, and a full decode', () => {
    const fourK = inputProbe({
      duration: 10.1,
      streams: [
        { type: 'video', width: 3840, height: 2160, fps: 30 },
        { type: 'audio' },
      ],
    })
    expect(() => validateInput('4k', fourK, { status: 0 })).not.toThrow()
    expect(() => validateInput('4k', { ...fourK, duration: 9.99 }, { status: 0 })).toThrow(
      /10 seconds/i,
    )
    expect(() =>
      validateInput(
        '4k',
        { ...fourK, streams: [{ type: 'video', width: 3840, height: 2160, fps: 30 }] },
        { status: 0 },
      ),
    ).toThrow(/audio|sound/i)
    expect(() =>
      validateInput(
        '4k',
        {
          ...fourK,
          streams: [
            { type: 'video', width: 3840, height: 2160, fps: 60 },
            { type: 'audio' },
          ],
        },
        { status: 0 },
      ),
    ).toThrow(/30 fps/i)
    expect(() => validateInput('4k', fourK, { status: 1 })).toThrow(/decode/i)
  })
})

describe('the ranged media server', () => {
  it('answers a byte range with 206 and the exact slice', () => {
    const response = rangedResponse(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), 'bytes=2-5')

    expect(response.status).toBe(206)
    expect(response.headers).toMatchObject({
      'accept-ranges': 'bytes',
      'content-range': 'bytes 2-5/8',
      'content-length': '4',
    })
    expect([...response.body]).toEqual([2, 3, 4, 5])
  })

  it('answers the whole file only when no Range was requested', () => {
    expect(rangedResponse(new Uint8Array([0, 1, 2]), undefined)).toMatchObject({
      status: 200,
      headers: { 'content-length': '3', 'accept-ranges': 'bytes' },
    })
    expect(rangedResponse(new Uint8Array([0, 1, 2]), 'bytes=9-12').status).toBe(416)
  })

  it('serves a real file through a real HTTP byte range', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'tailcut-windows-range-'))
    const source = path.join(work, 'source.mp4')
    await writeFile(source, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]))
    let server: { origin: string; close: () => Promise<void> } | undefined

    try {
      const liveServer = await createMediaServer(
        { source },
        { host: '127.0.0.1', port: 0 },
      )
      server = liveServer
      const response = await fetch(`${liveServer.origin}/media/source`, {
        headers: { Range: 'bytes=2-5' },
      })

      expect(response.status).toBe(206)
      expect(response.headers.get('accept-ranges')).toBe('bytes')
      expect(response.headers.get('content-range')).toBe('bytes 2-5/8')
      expect(response.headers.get('content-length')).toBe('4')
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3, 4, 5])
    } finally {
      await server?.close()
      await rm(work, { recursive: true, force: true })
    }
  })
})

describe('Chrome launch and cleanup', () => {
  const launch = {
    chrome: '/mnt/c/Chrome/chrome.exe',
    port: 9222,
    profileWindows: 'C:\\Temp\\tailcut\\run-1\\profile',
    extensionWindows: 'C:\\Temp\\tailcut\\run-1\\ext',
  }

  it('carries every flag required by Chrome for Testing', () => {
    expect(chromeLaunchArgs(launch)).toEqual(
      expect.arrayContaining([
        '--remote-debugging-port=9222',
        '--user-data-dir=C:\\Temp\\tailcut\\run-1\\profile',
        '--disable-extensions-except=C:\\Temp\\tailcut\\run-1\\ext',
        '--load-extension=C:\\Temp\\tailcut\\run-1\\ext',
      ]),
    )
  })

  it('refuses an occupied CDP port before it starts a server or process', async () => {
    const spawn = vi.fn()
    const openServer = vi.fn()
    await expect(
      startBrowserSession(launch, {
        portIsFree: async (): Promise<boolean> => false,
        spawn,
        openServer,
      }),
    ).rejects.toThrow(/9222.*occupied|port.*9222/i)
    expect(spawn).not.toHaveBeenCalled()
    expect(openServer).not.toHaveBeenCalled()
  })

  it('closes the server and kills only its own PID when attach fails', async () => {
    const closeServer = vi.fn(async (): Promise<void> => undefined)
    const kill = vi.fn(async (_pid: number): Promise<void> => undefined)
    const removeTree = vi.fn()

    await expect(
      startBrowserSession(launch, {
        portIsFree: async (): Promise<boolean> => true,
        openServer: async () => ({ close: closeServer }),
        spawn: async () => ({ pid: 7341 }),
        attach: async () => {
          throw new Error('CDP refused the connection')
        },
        kill,
        removeTree,
      }),
    ).rejects.toThrow(/CDP refused/)

    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(7341)
    expect(closeServer).toHaveBeenCalledTimes(1)
    expect(removeTree, 'a run directory is never recursively deleted').not.toHaveBeenCalled()
  })

  it('closes a successful session without recursively deleting its run directory', async () => {
    const closeServer = vi.fn(async (): Promise<void> => undefined)
    const send = vi.fn(async (_method: string): Promise<void> => undefined)
    const removeTree = vi.fn()
    const kill = vi.fn()
    const spawn = vi.fn(async (_chrome: string, _args: string[]) => ({ pid: 7341 }))
    const session = await startBrowserSession(launch, {
      portIsFree: async (): Promise<boolean> => true,
      openServer: async () => ({ close: closeServer }),
      spawn,
      attach: async () => ({ cdp: { send } }),
      kill,
      removeTree,
    })

    await session.close()

    expect(send).toHaveBeenCalledWith('Browser.close')
    expect(closeServer).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(
      launch.chrome,
      expect.arrayContaining([
        '--remote-debugging-port=9222',
        '--user-data-dir=C:\\Temp\\tailcut\\run-1\\profile',
        '--disable-extensions-except=C:\\Temp\\tailcut\\run-1\\ext',
        '--load-extension=C:\\Temp\\tailcut\\run-1\\ext',
      ]),
    )
    expect(kill).not.toHaveBeenCalled()
    expect(removeTree, 'artifacts and the partial report remain for diagnosis').not.toHaveBeenCalled()
  })

  it('still closes the media server when Browser.close fails', async () => {
    const closeServer = vi.fn(async (): Promise<void> => undefined)
    const kill = vi.fn(async (_pid: number): Promise<void> => undefined)
    const send = vi.fn(async (method: string): Promise<void> => {
      if (method === 'Browser.close') throw new Error('CDP browser close failed')
    })
    const session = await startBrowserSession(launch, {
      portIsFree: async (): Promise<boolean> => true,
      openServer: async () => ({ close: closeServer }),
      spawn: async () => ({ pid: 7341 }),
      attach: async () => ({ cdp: { send } }),
      kill,
      removeTree: vi.fn(),
    })

    await expect(session.close()).rejects.toThrow(/browser close failed/i)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(7341)
    expect(closeServer).toHaveBeenCalledTimes(1)
  })

  it('waits for its exact PID and port, then fails after killing only that stuck PID', async () => {
    const order: string[] = []
    const closeServer = vi.fn(async (): Promise<void> => {
      order.push('server:close')
    })
    const send = vi.fn(async (method: string): Promise<void> => {
      order.push(method)
    })
    const waitForExit = vi.fn(async (pid: number, port: number): Promise<boolean> => {
      order.push(`wait:${pid}:${port}`)
      return false
    })
    const kill = vi.fn(async (pid: number): Promise<void> => {
      order.push(`kill:${pid}`)
    })
    const session = await startBrowserSession(launch, {
      portIsFree: async (): Promise<boolean> => true,
      openServer: async () => ({ close: closeServer }),
      spawn: async () => ({ pid: 7341 }),
      attach: async () => ({ cdp: { send } }),
      waitForExit,
      kill,
      removeTree: vi.fn(),
    })

    await expect(session.close()).rejects.toThrow(/PID 7341|did not exit|still running/i)
    expect(waitForExit).toHaveBeenCalledTimes(1)
    expect(waitForExit).toHaveBeenCalledWith(7341, 9222)
    expect(kill).toHaveBeenCalledTimes(1)
    expect(kill).toHaveBeenCalledWith(7341)
    expect(order).toEqual([
      'Browser.close',
      'wait:7341:9222',
      'kill:7341',
      'server:close',
    ])
  })
})

describe('watched media, not buffered media', () => {
  it('plays media time continuously until a minute was actually watched', async () => {
    let currentTime = 0
    const play = vi.fn(async (): Promise<void> => undefined)
    const setPlaybackRate = vi.fn((_rate: number): void => undefined)
    const waitFrame = vi.fn(async (): Promise<void> => {
      currentTime += 10
    })

    await driveWatchedMedia(
      {
        play,
        setPlaybackRate,
        currentTime: (): number => currentTime,
        bufferedEnd: (): number => 60,
        waitFrame,
      },
      { targetSeconds: 60, maxPolls: 7 },
    )

    expect(play).toHaveBeenCalledTimes(1)
    expect(setPlaybackRate).toHaveBeenCalledWith(expect.any(Number))
    expect(waitFrame).toHaveBeenCalledTimes(6)
  })

  it('does not turn a full buffered range into watched time', async () => {
    await expect(
      driveWatchedMedia(
        {
          play: async (): Promise<void> => undefined,
          setPlaybackRate: (_rate: number): void => undefined,
          currentTime: (): number => 0,
          bufferedEnd: (): number => 60,
          waitFrame: async (): Promise<void> => undefined,
        },
        { targetSeconds: 60, maxPolls: 3 },
      ),
    ).rejects.toThrow(/playback|watched|media time/i)
  })

  it('requires the editor Out field to reach the watched minute', () => {
    expect(() => assertWatchedOut(59)).not.toThrow()
    expect(() => assertWatchedOut(58.999)).toThrow(/Out.*59/i)
  })
})

describe('the exact extension identity', () => {
  const expected = {
    workerPath: '/sw/service-worker.js',
    name: 'tailcut',
    version: '0.1.0',
    nonce: 'run-only-57af',
  }

  it('stamps only the copied manifest with the run nonce', () => {
    const source = { name: 'tailcut', version: '0.1.0', background: { service_worker: 'sw/service-worker.js' } }
    const copy = stampExtensionIdentity(source, expected.nonce)

    expect(copy).toMatchObject({ tailcut_run_nonce: expected.nonce })
    expect(source).not.toHaveProperty('tailcut_run_nonce')
  })

  it('accepts only one candidate matching worker, name, version, and nonce', () => {
    const ours = {
      workerUrl: 'chrome-extension://ours/sw/service-worker.js',
      name: 'tailcut',
      version: '0.1.0',
      nonce: 'run-only-57af',
    }
    expect(verifyExtensionIdentity([ours], expected)).toEqual(ours)

    for (const impostor of [
      { ...ours, workerUrl: 'chrome-extension://ours/sw/sweeper.js' },
      { ...ours, name: 'Google Network Speech' },
      { ...ours, version: '9.9.9' },
      { ...ours, nonce: 'another-checkout' },
    ]) {
      expect(() => verifyExtensionIdentity([impostor], expected)).toThrow(/extension|identity/i)
    }
  })

  it('does not accept a component beside the exact extension', () => {
    expect(() =>
      verifyExtensionIdentity(
        [
          {
            workerUrl: 'chrome-extension://component/sw/service-worker.js',
            name: 'Google Network Speech',
            version: '0.1.0',
            nonce: 'run-only-57af',
          },
        ],
        expected,
      ),
    ).toThrow(/extension|identity/i)
  })
})

describe('attached-browser downloads', () => {
  it('arms the extension download call and records its URL, requested name, and id', async () => {
    type CaptureState = {
      calls: Array<{ url: string; requestedFilename: string; downloadId: number | null }>
    }
    let state: CaptureState | undefined
    let delegatedCallback: ((id?: number) => void) | undefined
    let releaseId!: () => void
    const idReady = new Promise<void>((resolve) => {
      releaseId = resolve
    })
    const delegated = vi.fn((
      _options: { url: string; filename: string },
      callback: (id?: number) => void,
    ): void => {
      delegatedCallback = callback
    })
    const downloads = { download: delegated }
    const evaluate = vi.fn(async (body: () => unknown) => {
      const scope = globalThis as unknown as Record<string, unknown>
      const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
      const captureDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'tcWindowsDownloadCapture')
      Object.defineProperty(globalThis, 'chrome', {
        configurable: true,
        value: { downloads },
      })
      try {
        const result = body()
        state = scope.tcWindowsDownloadCapture as CaptureState
        return result
      } finally {
        if (chromeDescriptor) Object.defineProperty(globalThis, 'chrome', chromeDescriptor)
        else delete scope.chrome
        if (captureDescriptor) {
          Object.defineProperty(globalThis, 'tcWindowsDownloadCapture', captureDescriptor)
        } else {
          delete scope.tcWindowsDownloadCapture
        }
      }
    })
    const waitForFunction = vi.fn(async (
      _predicate: (index: number) => unknown,
      index: number,
      _options: { timeout: number },
    ) => ({
      jsonValue: async () => {
        await idReady
        return state?.calls[index]
      },
    }))
    const capture = await armDownloadCapture({ evaluate, waitForFunction })
    const callback = vi.fn()
    const requested = {
      url: 'blob:chrome-extension://tailcut/export-41',
      filename: 'windows-hevc-1080.mp4',
    }

    downloads.download(requested, callback)

    expect(delegated).toHaveBeenCalledWith(requested, expect.any(Function))
    expect(state?.calls).toEqual([{
      url: requested.url,
      requestedFilename: requested.filename,
      downloadId: null,
    }])
    delegatedCallback?.(41)
    releaseId()
    expect(callback).toHaveBeenCalledWith(41)
    await expect(capture.expected).resolves.toEqual({
      url: requested.url,
      requestedFilename: requested.filename,
      downloadId: 41,
    })
  })

  it('buffers CDP events until the expected call is known, then removes both listeners', async () => {
    type Handler = (params: Record<string, unknown>) => void
    const handlers = new Map<string, Set<Handler>>()
    const on = vi.fn((name: string, handler: Handler): void => {
      const atName = handlers.get(name) ?? new Set<Handler>()
      atName.add(handler)
      handlers.set(name, atName)
    })
    const off = vi.fn((name: string, handler: Handler): void => {
      handlers.get(name)?.delete(handler)
    })
    const emit = (name: string, params: Record<string, unknown>): void => {
      for (const handler of handlers.get(name) ?? []) handler(params)
    }
    let resolveExpected!: (value: {
      url: string
      requestedFilename: string
      downloadId: number
    }) => void
    const expected = new Promise<{
      url: string
      requestedFilename: string
      downloadId: number
    }>((resolve) => {
      resolveExpected = resolve
    })

    const completed = completedDownload({ cdp: { on, off } }, expected, 1_000)

    expect(on).toHaveBeenCalledTimes(2)
    emit('Browser.downloadWillBegin', {
      guid: 'other-guid',
      url: 'blob:other',
      suggestedFilename: 'other.zip',
    })
    emit('Browser.downloadProgress', {
      guid: 'other-guid',
      state: 'completed',
      filePath: 'C:\\Downloads\\other.zip',
    })
    emit('Browser.downloadWillBegin', {
      guid: 'tailcut-guid',
      url: 'blob:tailcut-export',
      suggestedFilename: 'clip.mp4',
    })
    emit('Browser.downloadProgress', {
      guid: 'tailcut-guid',
      state: 'completed',
      filePath: 'C:\\Temp\\tailcut\\run-1\\downloads\\clip.mp4',
    })
    resolveExpected({
      url: 'blob:tailcut-export',
      requestedFilename: 'windows-hevc-1080.mp4',
      downloadId: 41,
    })

    await expect(completed).resolves.toEqual({
      guid: 'tailcut-guid',
      suggestedFilename: 'clip.mp4',
      url: 'blob:tailcut-export',
      filePath: 'C:\\Temp\\tailcut\\run-1\\downloads\\clip.mp4',
      requestedFilename: 'windows-hevc-1080.mp4',
      downloadId: 41,
    })
    expect(off).toHaveBeenCalledTimes(2)
    expect([...handlers.values()].every((atName) => atName.size === 0)).toBe(true)
  })

  it('enables browser events and names the native Windows download directory', () => {
    expect(downloadBehavior('C:\\Temp\\tailcut\\run-1\\downloads')).toEqual({
      behavior: 'allow',
      downloadPath: 'C:\\Temp\\tailcut\\run-1\\downloads',
      eventsEnabled: true,
    })
    expect(() => downloadBehavior('/mnt/c/Temp/tailcut/run-1/downloads')).toThrow(/Windows/i)
  })

  it('sends Browser.setDownloadBehavior over the browser CDP session', async () => {
    const send = vi.fn(async (_method: string, _params: unknown): Promise<void> => undefined)

    await enableDownloads({ send }, 'C:\\Temp\\tailcut\\run-1\\downloads')

    expect(send).toHaveBeenCalledWith('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: 'C:\\Temp\\tailcut\\run-1\\downloads',
      eventsEnabled: true,
    })
  })

  it('waits for willBegin and the matching completed event', async () => {
    async function* events(): AsyncGenerator<DownloadEvent> {
      yield {
        method: 'Browser.downloadWillBegin',
        params: { guid: 'download-1', suggestedFilename: 'clip.mp4' },
      }
      yield {
        method: 'Browser.downloadProgress',
        params: { guid: 'download-1', state: 'inProgress' },
      }
      yield {
        method: 'Browser.downloadProgress',
        params: { guid: 'download-1', state: 'completed' },
      }
    }

    await expect(
      waitForDownload(events(), new Promise<never>(() => undefined)),
    ).resolves.toEqual({ guid: 'download-1', suggestedFilename: 'clip.mp4' })
  })

  it('uses the deadline only as failure and never as fake completion', async () => {
    async function* events(): AsyncGenerator<DownloadEvent> {
      yield {
        method: 'Browser.downloadWillBegin',
        params: { guid: 'download-1', suggestedFilename: 'clip.mp4' },
      }
      await new Promise<never>(() => undefined)
    }
    const deadline = Promise.reject(new Error('download deadline'))

    await expect(waitForDownload(events(), deadline)).rejects.toThrow(/deadline/i)
  })

  it('ignores an unrelated download and completes only the expected URL and guid', async () => {
    async function* events(): AsyncGenerator<DownloadEvent> {
      yield {
        method: 'Browser.downloadWillBegin',
        params: {
          guid: 'unrelated-guid',
          suggestedFilename: 'other.zip',
          url: 'blob:unrelated',
        },
      }
      yield {
        method: 'Browser.downloadProgress',
        params: { guid: 'unrelated-guid', state: 'completed', filePath: 'C:\\Downloads\\other.zip' },
      }
      yield {
        method: 'Browser.downloadWillBegin',
        params: {
          guid: 'tailcut-guid',
          suggestedFilename: 'clip.mp4',
          url: 'blob:tailcut-export',
        },
      }
      yield {
        method: 'Browser.downloadProgress',
        params: { guid: 'unrelated-guid', state: 'inProgress' },
      }
      yield {
        method: 'Browser.downloadProgress',
        params: {
          guid: 'tailcut-guid',
          state: 'completed',
          filePath: 'C:\\Temp\\tailcut\\run-1\\downloads\\clip.mp4',
        },
      }
    }

    await expect(
      waitForDownload(
        events(),
        new Promise<never>(() => undefined),
        { expectedUrl: 'blob:tailcut-export' },
      ),
    ).resolves.toMatchObject({
      guid: 'tailcut-guid',
      suggestedFilename: 'clip.mp4',
      url: 'blob:tailcut-export',
      filePath: 'C:\\Temp\\tailcut\\run-1\\downloads\\clip.mp4',
    })
  })

  it('accepts only a completed artifact directly below the run download root', () => {
    const root = '/mnt/c/Temp/tailcut/run-1/downloads'
    expect(completedDownloadPath(root, 'C:\\Temp\\tailcut\\run-1\\downloads\\clip.mp4')).toBe(
      `${root}/clip.mp4`,
    )

    for (const unsafe of [
      undefined,
      'C:\\Temp\\tailcut\\run-1\\downloads-other\\clip.mp4',
      'C:\\Temp\\tailcut\\run-1\\downloads\\..\\clip.mp4',
      'C:\\Temp\\tailcut\\run-1\\downloads\\nested\\clip.mp4',
    ]) {
      expect(() => completedDownloadPath(root, unsafe), String(unsafe)).toThrow(
        /file path|direct child|download directory/i,
      )
    }
  })

  it('records the native artifact byte size after both browser paths agree', async () => {
    const root = '/mnt/c/Temp/tailcut/run-1/downloads'
    const windowsFile = 'C:\\Temp\\tailcut\\run-1\\downloads\\clip.mp4'
    const readStat = vi.fn(async (_path: string) => ({ size: 12_345 }))

    await expect(
      inspectDownloadedArtifact(root, windowsFile, windowsFile, readStat),
    ).resolves.toEqual({ path: `${root}/clip.mp4`, bytes: 12_345 })
    expect(readStat).toHaveBeenCalledWith(`${root}/clip.mp4`)
  })

  it('accepts only the exact complete DownloadItem owned by this Tailcut checkout', () => {
    const expected = {
      downloadId: 41,
      url: 'blob:tailcut-export',
      extensionId: 'tailcut-extension-id',
    }
    const item = {
      id: 41,
      url: 'blob:tailcut-export',
      state: 'complete',
      byExtensionId: 'tailcut-extension-id',
      filename: 'C:\\Temp\\tailcut\\run-1\\downloads\\clip.mp4',
    }
    expect(verifyDownloadIdentity(item, expected)).toEqual(item)

    for (const impostor of [
      { ...item, id: 42 },
      { ...item, url: 'blob:another-export' },
      { ...item, state: 'interrupted' },
      { ...item, byExtensionId: 'another-extension' },
    ]) {
      expect(() => verifyDownloadIdentity(impostor, expected)).toThrow(/download|identity|Tailcut/i)
    }
  })

  it('closes the attached browser through CDP, not through browser.close', async () => {
    const send = vi.fn(async (_method: string): Promise<void> => undefined)
    const close = vi.fn(async (): Promise<void> => undefined)

    await closeAttachedBrowser({ send }, { close })

    expect(send).toHaveBeenCalledWith('Browser.close')
    expect(close).not.toHaveBeenCalled()
  })
})

describe('the required export plan', () => {
  it('uses HEVC for the 1080 editor and H.264 for the 4K editor', () => {
    expect(codecForEditor('1080')).toBe('hevc')
    expect(codecForEditor('4k')).toBe('h264')
  })

  it('forces the codecs and carries the exact crop and WebP duration', () => {
    expect(exportPlan(false)).toEqual([
      expect.objectContaining({ id: 'hevc-1080', required: true, format: 'mp4', mode: 'optimize', codec: 'hevc' }),
      expect.objectContaining({
        id: 'crop-128x64',
        required: true,
        format: 'mp4',
        mode: 'optimize',
        codec: 'hevc',
        crop: { width: 128, height: 64 },
      }),
      expect.objectContaining({ id: 'webp-10s', required: true, format: 'webp', duration: 10 }),
      expect.objectContaining({ id: 'h264-4k', required: false, status: 'skipped', codec: 'h264' }),
    ])
  })

  it('adds the forced H.264 4K export only when real 4K material exists', () => {
    const fourK = exportPlan(true).find((item: { id: string }) => item.id === 'h264-4k')
    expect(fourK).toMatchObject({
      required: true,
      format: 'mp4',
      mode: 'optimize',
      codec: 'h264',
      width: 3840,
      height: 2160,
    })
  })
})

describe('export acceptance', () => {
  it('asks ffprobe for packets and derives B-frames from their PTS and DTS', () => {
    expect(ffprobeExportCommand('/tmp/output.mp4')).toEqual([
      'ffprobe',
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-show_packets',
      '-of',
      'json',
      '/tmp/output.mp4',
    ])

    const facts = exportProbeFacts({
      bFrames: 999,
      format: { duration: '60.010000' },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'hevc',
          width: 1920,
          height: 1080,
          level: 120,
          start_time: '0.000000',
        },
        { index: 1, codec_type: 'audio', start_time: '0.010000' },
      ],
      packets: [
        { stream_index: 0, pts_time: '0.000000', dts_time: '0.000000' },
        { stream_index: 0, pts_time: '0.066667', dts_time: '0.033333' },
        { stream_index: 0, pts_time: '0.033333', dts_time: '0.066667' },
        { stream_index: 0, pts_time: '0.100000', dts_time: '0.100000' },
        { stream_index: 1, pts_time: '0.010000', dts_time: '0.010000' },
      ],
    })

    expect(facts).toMatchObject({
      width: 1920,
      height: 1080,
      duration: 60.01,
      hasAudio: true,
      codec: 'hevc',
      level: 120,
      firstVideoPts: 0,
      videoStart: 0,
      audioStart: 0.01,
      bFrames: 2,
    })
  })

  it('uses the earliest presentation PTS instead of the first packet in decode order', () => {
    const facts = exportProbeFacts({
      format: { duration: '60.010000' },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'hevc',
          width: 1920,
          height: 1080,
          avg_frame_rate: '30/1',
          start_time: '0.066667',
        },
        { index: 1, codec_type: 'audio', start_time: '0.010000' },
      ],
      packets: [
        { stream_index: 0, pts_time: '0.066667', dts_time: '0.000000' },
        { stream_index: 0, pts_time: '0.000000', dts_time: '0.033333' },
        { stream_index: 0, pts_time: '0.033333', dts_time: '0.066667' },
        { stream_index: 1, pts_time: '0.010000', dts_time: '0.010000' },
      ],
    })

    expect(facts.firstVideoPts).toBe(0)
    expect(facts.videoStart).toBe(0)
    expect(facts.audioStart).toBe(0.01)
  })

  it('derives one frame from the actual 60 fps stream', () => {
    const facts = exportProbeFacts({
      format: { duration: '60.010000' },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'hevc',
          width: 1920,
          height: 1080,
          avg_frame_rate: '60/1',
          start_time: '0.000000',
        },
        { index: 1, codec_type: 'audio', start_time: '0.010000' },
      ],
      packets: [
        { stream_index: 0, pts_time: '0.000000', dts_time: '0.000000' },
        { stream_index: 0, pts_time: '0.016667', dts_time: '0.016667' },
        { stream_index: 1, pts_time: '0.010000', dts_time: '0.010000' },
      ],
    }) as { frameDuration: number }

    expect(facts.frameDuration).toBeCloseTo(1 / 60, 6)
  })

  it('rejects a 20 ms A/V start skew in a 60 fps export', async () => {
    await expect(
      validateExport(
        { id: 'hevc-1080', expectedChoice: 'HEVC in hardware' },
        { ...mp4Probe({ audioStart: 0.02 }), frameDuration: 1 / 60 },
        { decodeWebp: vi.fn() },
      ),
    ).rejects.toThrow(/A\/V|frame/i)
  })

  it.each([
    ['missing', []],
    ['non-finite', [{ stream_index: 1, pts_time: 'N/A', dts_time: 'N/A' }]],
  ])('rejects %s audio packet timing', (_name, audioPackets) => {
    expect(() =>
      exportProbeFacts({
        format: { duration: '60.010000' },
        streams: [
          {
            index: 0,
            codec_type: 'video',
            codec_name: 'hevc',
            width: 1920,
            height: 1080,
            avg_frame_rate: '30/1',
            start_time: '0.000000',
          },
          { index: 1, codec_type: 'audio', start_time: 'N/A' },
        ],
        packets: [
          { stream_index: 0, pts_time: '0.000000', dts_time: '0.000000' },
          ...audioPackets,
        ],
      }),
    ).toThrow(/audio.*timing|audio.*packet|finite/i)
  })

  it('counts reordered packets without requiring hardware to emit B-frames', () => {
    expect(
      countBFrames([
        { pts: 0, dts: 0 },
        { pts: 2 / 30, dts: 1 / 30 },
        { pts: 1 / 30, dts: 2 / 30 },
        { pts: 3 / 30, dts: 3 / 30 },
      ]),
    ).toBe(2)
    expect(
      countBFrames([
        { pts: 0, dts: 0 },
        { pts: 1 / 30, dts: 1 / 30 },
      ]),
    ).toBe(0)
  })

  it('accepts a minute HEVC file with sound, zero PTS, sync, and measured B-frames', async () => {
    await expect(
      validateExport(
        { id: 'hevc-1080', expectedChoice: 'HEVC in hardware' },
        mp4Probe(),
        { decodeWebp: vi.fn() },
      ),
    ).resolves.toBeUndefined()
  })

  it.each([
    ['selected rung', { selectedChoice: 'H.264 in software' }, /HEVC in hardware/i],
    ['geometry', { width: 1280 }, /1920.*1080/i],
    ['codec', { codec: 'h264' }, /HEVC/i],
    ['duration', { duration: 59.8 }, /60 seconds/i],
    ['sound', { hasAudio: false }, /audio|sound/i],
    ['decode', { decoded: false }, /decode/i],
    ['first video PTS', { firstVideoPts: 0.04 }, /PTS.*zero/i],
    ['A/V start', { audioStart: 0.05 }, /A\/V|frame/i],
  ] as const)('rejects the wrong %s oracle independently', async (_name, mutation, message) => {
    await expect(
      validateExport(
        { id: 'hevc-1080', expectedChoice: 'HEVC in hardware' },
        mp4Probe(mutation),
        { decodeWebp: vi.fn() },
      ),
    ).rejects.toThrow(message)
  })

  it('requires the crop to be exactly 128 by 64 and software H.264', async () => {
    const crop = mp4Probe({
      width: 128,
      height: 64,
      duration: 60,
      codec: 'h264',
      selectedChoice: 'H.264 in software',
    })
    await expect(
      validateExport(
        { id: 'crop-128x64', expectedChoice: 'H.264 in software' },
        crop,
        { decodeWebp: vi.fn() },
      ),
    ).resolves.toBeUndefined()
    await expect(
      validateExport(
        { id: 'crop-128x64', expectedChoice: 'H.264 in software' },
        { ...crop, width: 130 },
        { decodeWebp: vi.fn() },
      ),
    ).rejects.toThrow(/128.*64/i)
  })

  it('requires computed H.264 level 5.1 for 4K30', async () => {
    const fourK = mp4Probe({
      width: 3840,
      height: 2160,
      duration: 10,
      codec: 'h264',
      selectedChoice: 'H.264 in hardware',
      level: 51,
    })
    await expect(
      validateExport(
        { id: 'h264-4k', expectedChoice: 'H.264 in hardware' },
        fourK,
        { decodeWebp: vi.fn() },
      ),
    ).resolves.toBeUndefined()
    await expect(
      validateExport(
        { id: 'h264-4k', expectedChoice: 'H.264 in hardware' },
        { ...fourK, level: 40 },
        { decodeWebp: vi.fn() },
      ),
    ).rejects.toThrow(/5\.1|level/i)
  })

  it('decodes every live WebP frame and closes each browser resource', async () => {
    const imageCloses = [vi.fn(), vi.fn(), vi.fn()]
    const durationsUs = [1_000_000, 2_000_000, 3_000_000]
    const decodedIndexes: number[] = []
    const decoderClose = vi.fn()
    const decoderOptions: unknown[] = []
    const fetch = vi.fn(async (_source: string) => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer,
    }))
    class FakeImageDecoder {
      tracks = {
        ready: Promise.resolve(),
        selectedTrack: { frameCount: durationsUs.length },
      }

      constructor(options: unknown) {
        decoderOptions.push(options)
      }

      async decode({ frameIndex }: { frameIndex: number }) {
        decodedIndexes.push(frameIndex)
        return {
          complete: true,
          image: {
            duration: durationsUs[frameIndex],
            close: imageCloses[frameIndex],
          },
        }
      }

      close(): void {
        decoderClose()
      }
    }
    const evaluate = vi.fn(async (
      body: (source: string) => Promise<unknown>,
      source: string,
    ) => {
      const scope = globalThis as unknown as Record<string, unknown>
      const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
      const decoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ImageDecoder')
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetch })
      Object.defineProperty(globalThis, 'ImageDecoder', {
        configurable: true,
        value: FakeImageDecoder,
      })
      try {
        return await body(source)
      } finally {
        if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor)
        else delete scope.fetch
        if (decoderDescriptor) Object.defineProperty(globalThis, 'ImageDecoder', decoderDescriptor)
        else delete scope.ImageDecoder
      }
    })
    const exposeArtifact = vi.fn((_key: string, artifact: string) => {
      expect(artifact).toBe('/mnt/c/downloads/clip.webp')
      return 'http://127.0.0.1:43127/artifact/clip'
    })

    const result = await decodeWebp('/mnt/c/downloads/clip.webp', {
      mediaServer: { exposeArtifact },
      currentEditor: { evaluate },
    })

    expect(result).toEqual({ durationMs: 6_000, frames: 3 })
    expect(exposeArtifact).toHaveBeenCalledWith(expect.stringMatching(/^webp-/), '/mnt/c/downloads/clip.webp')
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:43127/artifact/clip')
    expect(decoderOptions).toEqual([
      expect.objectContaining({ type: 'image/webp', preferAnimation: true }),
    ])
    expect(decodedIndexes).toEqual([0, 1, 2])
    for (const close of imageCloses) expect(close).toHaveBeenCalledTimes(1)
    expect(decoderClose).toHaveBeenCalledTimes(1)
  })

  it('uses ImageDecoder to prove a ten-second animated WebP', async () => {
    const decodeWebp = vi.fn(async () => ({ durationMs: 10_000, frames: 100 }))
    await expect(
      validateExport(
        { id: 'webp-10s' },
        { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]) },
        { decodeWebp },
      ),
    ).resolves.toBeUndefined()
    expect(decodeWebp).toHaveBeenCalledTimes(1)

    decodeWebp.mockResolvedValueOnce({ durationMs: 9_000, frames: 100 })
    await expect(
      validateExport(
        { id: 'webp-10s' },
        { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]) },
        { decodeWebp },
      ),
    ).rejects.toThrow(/10 seconds|10,000/i)
  })

  it('keeps a partial JSON report, closes Chrome, and returns failure on an oracle error', async () => {
    const reports: unknown[] = []
    const close = vi.fn(async (): Promise<void> => undefined)
    const result = await runExports(exportPlan(false), {
      exportOne: async (item: { id: string }) => {
        if (item.id === 'crop-128x64') throw new Error('crop is 130x64')
        return { id: item.id, status: 'passed' }
      },
      writeReport: async (report: unknown): Promise<void> => {
        reports.push(structuredClone(report))
      },
      closeBrowser: close,
    })

    expect(result.exitCode).not.toBe(0)
    expect(reports.length).toBeGreaterThan(0)
    expect(reports.at(-1)).toMatchObject({
      status: 'failed',
      exports: [
        { id: 'hevc-1080', status: 'passed' },
        { id: 'crop-128x64', status: 'failed' },
      ],
    })
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('live Windows run', () => {
  const args = [
    '--chrome',
    '/mnt/c/Chrome/chrome.exe',
    '--dist',
    '/repo/dist',
    '--media-1080',
    '/mnt/c/media/minute.mp4',
    '--media-4k',
    '/mnt/c/media/4k.mp4',
    '--work-root',
    '/mnt/c/Users/alice/AppData/Local/Temp/tailcut/20260830-golden',
    '--windows-temp',
    'C:\\Users\\alice\\AppData\\Local\\Temp',
    '--port',
    '9222',
  ]

  const fourKInput = inputProbe({
    duration: 10.1,
    streams: [
      { type: 'video', width: 3840, height: 2160, fps: 30 },
      { type: 'audio' },
    ],
  })

  const rawExportProbe = (id: string) => {
    const shape = id === 'crop-128x64'
      ? { codec: 'h264', width: 128, height: 64, duration: '60.010000', level: 40 }
      : id === 'h264-4k'
        ? { codec: 'h264', width: 3840, height: 2160, duration: '10.010000', level: 51 }
        : { codec: 'hevc', width: 1920, height: 1080, duration: '60.010000', level: 120 }

    return {
      bFrames: 999,
      format: { duration: shape.duration },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: shape.codec,
          width: shape.width,
          height: shape.height,
          level: shape.level,
          start_time: '0.000000',
        },
        { index: 1, codec_type: 'audio', start_time: '0.010000' },
      ],
      packets: [
        { stream_index: 0, pts_time: '0.000000', dts_time: '0.000000' },
        { stream_index: 0, pts_time: '0.066667', dts_time: '0.033333' },
        { stream_index: 0, pts_time: '0.033333', dts_time: '0.066667' },
        { stream_index: 1, pts_time: '0.010000', dts_time: '0.010000' },
      ],
    }
  }

  const liveHarness = (options: {
    outSeconds?: number
    choices?: Partial<Record<'hevc-1080' | 'crop-128x64' | 'h264-4k', string>>
  } = {}) => {
    const log: string[] = []
    const reports: Array<Record<string, unknown>> = []
    const nonce = 'run-only-57af'
    const extensionExpected = {
      workerPath: '/sw/service-worker.js',
      name: 'tailcut',
      version: '0.1.0',
      nonce,
    }
    const ours = {
      workerUrl: 'chrome-extension://ours/sw/service-worker.js',
      name: 'tailcut',
      version: '0.1.0',
      nonce,
    }
    const choices = {
      'hevc-1080': 'HEVC in hardware',
      'crop-128x64': 'H.264 in software',
      'h264-4k': 'H.264 in hardware',
      ...options.choices,
    }
    const matrix = Array.from({ length: 24 }, (_unused, index) => ({
      width: [640, 1280, 1920, 3840][Math.floor(index / 6)],
      height: [360, 720, 1080, 2160][Math.floor(index / 6)],
      framerate: index % 2 === 0 ? 30 : 60,
      kind: ['hevc-hw', 'h264-hw', 'h264-sw'][index % 3],
    }))
    const server = {
      origin: 'http://127.0.0.1:43127',
      close: vi.fn(async (): Promise<void> => {
        log.push('server:close')
      }),
    }
    const session = {
      cdp: { send: vi.fn() },
      close: vi.fn(async (): Promise<void> => {
        log.push('browser:Browser.close')
      }),
    }

    return {
      log,
      reports,
      server,
      session,
      dependencies: {
        defaultPaths: () => ({
          chrome: '/mnt/c/Chrome/chrome.exe',
          dist: '/repo/dist',
          tempWsl: '/mnt/c/Users/alice/AppData/Local/Temp',
          windowsTemp: 'C:\\Users\\alice\\AppData\\Local\\Temp',
          workRoot: '/mnt/c/Users/alice/AppData/Local/Temp/tailcut/unused-default',
        }),
        nonce: (): string => nonce,
        probeInput: async (kind: '1080' | '4k', input: string): Promise<InputProbe> => {
          log.push(`input:${kind}:probe`)
          expect(input).toBe(kind === '1080' ? '/mnt/c/media/minute.mp4' : '/mnt/c/media/4k.mp4')
          return kind === '1080' ? inputProbe() : fourKInput
        },
        decodeInput: async (kind: '1080' | '4k', input: string) => {
          log.push(`input:${kind}:full-decode`)
          expect(input).toBe(kind === '1080' ? '/mnt/c/media/minute.mp4' : '/mnt/c/media/4k.mp4')
          return { status: 0 }
        },
        copyExtension: async (source: string, target: string): Promise<void> => {
          log.push('extension:copy')
          expect(source).toBe('/repo/dist')
          expect(target).toMatch(/20260830-golden\/ext$/)
        },
        stampCopiedExtension: async (target: string, actualNonce: string) => {
          log.push('extension:stamp')
          expect(target).toMatch(/20260830-golden\/ext$/)
          expect(actualNonce).toBe(nonce)
          return extensionExpected
        },
        createMediaServer: async (files: Record<string, string>) => {
          log.push('server:start:ranged')
          expect(files).toEqual({
            'minute.mp4': '/mnt/c/media/minute.mp4',
            '4k.mp4': '/mnt/c/media/4k.mp4',
          })
          return server
        },
        startBrowserSession: async (launch: { chrome: string; port: number }) => {
          log.push('browser:start')
          expect(launch).toMatchObject({ chrome: '/mnt/c/Chrome/chrome.exe', port: 9222 })
          return session
        },
        extensionCandidates: async () => {
          log.push('identity:candidates')
          return [
            {
              ...ours,
              workerUrl: 'chrome-extension://component/sw/service-worker.js',
              name: 'Google Network Speech',
            },
            ours,
          ]
        },
        playWatchedMedia: async (kind: '1080' | '4k', url: string): Promise<void> => {
          log.push(`media:${kind}:play-continuous`)
          expect(url).toBe(
            `http://127.0.0.1:43127/media/${kind === '1080' ? 'minute.mp4' : '4k.mp4'}`,
          )
        },
        readEditorOut: async (kind: '1080' | '4k'): Promise<number> => {
          log.push(`editor:${kind}:read-out`)
          return kind === '1080' ? (options.outSeconds ?? 59) : 9
        },
        probeCodecMatrix: async () => {
          log.push('codec:probe-24')
          return matrix
        },
        enableDownloads: async (downloadPath: string): Promise<void> => {
          log.push('downloads:enable-cdp')
          expect(downloadPath).toBe(
            'C:\\Users\\alice\\AppData\\Local\\Temp\\tailcut\\20260830-golden\\downloads',
          )
        },
        configureExport: async (item: { id: string }): Promise<void> => {
          log.push(`export:${item.id}:configure`)
        },
        readInspectorChoice: async (item: { id: keyof typeof choices }): Promise<string> => {
          log.push(`export:${item.id}:read-inspector`)
          return choices[item.id]
        },
        clickExport: async (item: { id: string }): Promise<void> => {
          log.push(`export:${item.id}:click`)
        },
        waitForCompletedDownload: async (item: { id: string }) => {
          log.push(`export:${item.id}:download-completed`)
          return {
            guid: `guid-${item.id}`,
            suggestedFilename: `${item.id}.${item.id === 'webp-10s' ? 'webp' : 'mp4'}`,
            path: `/mnt/c/downloads/${item.id}.${item.id === 'webp-10s' ? 'webp' : 'mp4'}`,
          }
        },
        probeExport: async (item: { id: string }, artifact: string) => {
          log.push(`export:${item.id}:probe-packets`)
          expect(artifact).toContain(item.id)
          return rawExportProbe(item.id)
        },
        decodeExport: async (item: { id: string }, artifact: string) => {
          log.push(`export:${item.id}:full-decode`)
          expect(artifact).toContain(item.id)
          return { status: 0 }
        },
        readArtifact: async (item: { id: string }, artifact: string) => {
          log.push(`export:${item.id}:read-bytes`)
          expect(artifact).toContain(item.id)
          return new Uint8Array([0x52, 0x49, 0x46, 0x46])
        },
        decodeWebp: async (_bytes: Uint8Array) => {
          log.push('export:webp-10s:image-decoder')
          return { durationMs: 10_000, frames: 150 }
        },
        writeReport: async (report: Record<string, unknown>): Promise<void> => {
          reports.push(structuredClone(report))
          log.push(`report:${String(report.phase)}`)
        },
      },
    }
  }

  it('runs every live phase in order and validates completed native artifacts', async () => {
    const harness = liveHarness()

    const result = await runWindowsCheck(args, harness.dependencies)

    expect(result.exitCode).toBe(0)
    expect(harness.log).toEqual([
      'input:1080:probe',
      'input:1080:full-decode',
      'input:4k:probe',
      'input:4k:full-decode',
      'report:inputs',
      'extension:copy',
      'extension:stamp',
      'report:extension',
      'server:start:ranged',
      'browser:start',
      'identity:candidates',
      'report:identity',
      'media:1080:play-continuous',
      'editor:1080:read-out',
      'report:capture-1080',
      'media:4k:play-continuous',
      'editor:4k:read-out',
      'report:capture-4k',
      'codec:probe-24',
      'report:matrix',
      'downloads:enable-cdp',
      'report:downloads',
      'export:hevc-1080:configure',
      'export:hevc-1080:read-inspector',
      'report:export-hevc-1080-running',
      'export:hevc-1080:click',
      'export:hevc-1080:download-completed',
      'export:hevc-1080:probe-packets',
      'export:hevc-1080:full-decode',
      'report:export-hevc-1080',
      'export:crop-128x64:configure',
      'export:crop-128x64:read-inspector',
      'report:export-crop-128x64-running',
      'export:crop-128x64:click',
      'export:crop-128x64:download-completed',
      'export:crop-128x64:probe-packets',
      'export:crop-128x64:full-decode',
      'report:export-crop-128x64',
      'export:webp-10s:configure',
      'export:webp-10s:click',
      'export:webp-10s:download-completed',
      'export:webp-10s:read-bytes',
      'export:webp-10s:image-decoder',
      'report:export-webp-10s',
      'export:h264-4k:configure',
      'export:h264-4k:read-inspector',
      'report:export-h264-4k-running',
      'export:h264-4k:click',
      'export:h264-4k:download-completed',
      'export:h264-4k:probe-packets',
      'export:h264-4k:full-decode',
      'report:export-h264-4k',
      'browser:Browser.close',
      'server:close',
      'report:complete',
    ])
    expect(result.report).toMatchObject({
      status: 'passed',
      identity: { workerUrl: 'chrome-extension://ours/sw/service-worker.js' },
      matrix: harness.reports.find((report) => report.phase === 'matrix')?.matrix,
      exports: [
        { id: 'hevc-1080', status: 'passed', selectedChoice: 'HEVC in hardware', bFrames: 2 },
        { id: 'crop-128x64', status: 'passed', selectedChoice: 'H.264 in software', bFrames: 2 },
        { id: 'webp-10s', status: 'passed', durationMs: 10_000, frames: 150 },
        { id: 'h264-4k', status: 'passed', selectedChoice: 'H.264 in hardware', level: 51, bFrames: 2 },
      ],
    })
    expect((result.report.matrix as { rows: unknown[] }).rows).toHaveLength(24)
    expect(harness.reports.find((report) => report.phase === 'export-hevc-1080-running')).toMatchObject({
      exports: [{ id: 'hevc-1080', status: 'running', selectedChoice: 'HEVC in hardware' }],
    })
    expect(harness.reports.length).toBeGreaterThanOrEqual(10)
    expect(harness.reports.at(-1)).toMatchObject({ phase: 'complete', status: 'passed' })
    expect(harness.session.close).toHaveBeenCalledTimes(1)
    expect(harness.server.close).toHaveBeenCalledTimes(1)
  })

  it('refuses a wrong inspector rung before clicking export and still closes both owners', async () => {
    const harness = liveHarness({ choices: { 'hevc-1080': 'H.264 in software' } })

    const result = await runWindowsCheck(args, harness.dependencies)

    expect(result.exitCode).not.toBe(0)
    expect(harness.log).toContain('export:hevc-1080:read-inspector')
    expect(harness.log).not.toContain('export:hevc-1080:click')
    expect(harness.reports.at(-1)).toMatchObject({ status: 'failed' })
    expect(harness.session.close).toHaveBeenCalledTimes(1)
    expect(harness.server.close).toHaveBeenCalledTimes(1)
  })

  it('records the export whose live artifact oracle failed', async () => {
    const harness = liveHarness()
    const probeExport = harness.dependencies.probeExport
    harness.dependencies.probeExport = async (item: { id: string }, artifact: string) => {
      if (item.id === 'crop-128x64') throw new Error('ffprobe rejected the crop artifact')
      return probeExport(item, artifact)
    }

    const result = await runWindowsCheck(args, harness.dependencies)

    expect(result.exitCode).not.toBe(0)
    expect(harness.reports.at(-1)).toMatchObject({
      status: 'failed',
      exports: [
        { id: 'hevc-1080', status: 'passed' },
        {
          id: 'crop-128x64',
          status: 'failed',
          selectedChoice: 'H.264 in software',
          error: expect.stringMatching(/ffprobe rejected/),
        },
      ],
    })
  })

  it('turns a cleanup failure into the last persisted failed report', async () => {
    const harness = liveHarness()
    harness.session.close.mockImplementationOnce(async (): Promise<void> => {
      harness.log.push('browser:Browser.close')
      throw new Error('Browser.close left PID 7341 alive')
    })

    const result = await runWindowsCheck(args, harness.dependencies)

    expect(result.exitCode).not.toBe(0)
    expect(harness.log.slice(-3)).toEqual([
      'browser:Browser.close',
      'server:close',
      'report:failed',
    ])
    expect(harness.reports.at(-1)).toMatchObject({
      phase: 'failed',
      status: 'failed',
      error: { message: expect.stringMatching(/PID 7341 alive/) },
    })
  })

  it('stops at a short recorded Out before probes, downloads, or exports', async () => {
    const harness = liveHarness({ outSeconds: 58.999 })

    const result = await runWindowsCheck(args, harness.dependencies)

    expect(result.exitCode).not.toBe(0)
    expect(harness.log).toContain('editor:1080:read-out')
    expect(harness.log).not.toContain('codec:probe-24')
    expect(harness.log).not.toContain('downloads:enable-cdp')
    expect(harness.log.some((entry) => entry.startsWith('export:'))).toBe(false)
    expect(harness.reports.at(-1)).toMatchObject({ status: 'failed' })
    expect(harness.session.close).toHaveBeenCalledTimes(1)
    expect(harness.server.close).toHaveBeenCalledTimes(1)
  })

  it('uses deterministic defaults and generates the minute before a no-argument probe', async () => {
    const harness = liveHarness()
    const defaultRoot = '/mnt/c/Users/alice/AppData/Local/Temp/tailcut/20260830-default'
    const generated = `${defaultRoot}/media/minute.mp4`
    const order: string[] = []
    const defaultPaths = vi.fn(() => ({
      chrome: '/mnt/c/Chrome/chrome.exe',
      dist: '/repo/dist',
      tempWsl: '/mnt/c/Users/alice/AppData/Local/Temp',
      windowsTemp: 'C:\\Users\\alice\\AppData\\Local\\Temp',
      workRoot: defaultRoot,
    }))
    const dependencies = {
      ...harness.dependencies,
      defaultPaths,
      prepareRun: async (options: { workRoot: string; media1080: string }): Promise<void> => {
        order.push('prepare')
        expect(options).toMatchObject({ workRoot: defaultRoot, media1080: generated })
      },
      generateInput: async (output: string): Promise<void> => {
        order.push(`generate:${output}`)
        expect(output).toBe(generated)
      },
      probeInput: async (kind: '1080' | '4k', input: string): Promise<InputProbe> => {
        order.push(`probe:${kind}:${input}`)
        expect(kind).toBe('1080')
        expect(input).toBe(generated)
        return inputProbe()
      },
      decodeInput: async (kind: '1080' | '4k', input: string) => {
        order.push(`decode:${kind}:${input}`)
        return { status: 0 }
      },
      copyExtension: async (source: string, target: string): Promise<void> => {
        expect(source).toBe('/repo/dist')
        expect(target).toBe(`${defaultRoot}/ext`)
      },
      stampCopiedExtension: async (target: string, nonce: string) => {
        expect(target).toBe(`${defaultRoot}/ext`)
        return {
          workerPath: '/sw/service-worker.js',
          name: 'tailcut',
          version: '0.1.0',
          nonce,
        }
      },
      createMediaServer: async (files: Record<string, string>) => {
        expect(files).toEqual({ 'minute.mp4': generated })
        return harness.server
      },
      enableDownloads: async (downloadPath: string): Promise<void> => {
        expect(downloadPath).toBe(
          'C:\\Users\\alice\\AppData\\Local\\Temp\\tailcut\\20260830-default\\downloads',
        )
      },
    }

    const result = await runWindowsCheck([], dependencies)

    expect(result.exitCode).toBe(0)
    expect(defaultPaths).toHaveBeenCalledTimes(1)
    expect(order.slice(0, 4)).toEqual([
      'prepare',
      `generate:${generated}`,
      `probe:1080:${generated}`,
      `decode:1080:${generated}`,
    ])
    expect(result.report.inputs).not.toHaveProperty('4k')
    expect(result.report.exports).toContainEqual(
      expect.objectContaining({ id: 'h264-4k', status: 'skipped', required: false }),
    )
  })

  it('does not let --windows-temp certify an arbitrary work root', async () => {
    const prepareRun = vi.fn(async (): Promise<void> => undefined)
    const defaultPaths = vi.fn(() => ({
      chrome: '/mnt/c/Chrome/chrome.exe',
      dist: '/repo/dist',
      tempWsl: '/mnt/c/Users/alice/AppData/Local/Temp',
      windowsTemp: 'C:\\Users\\alice\\AppData\\Local\\Temp',
      workRoot: '/mnt/c/Users/alice/AppData/Local/Temp/tailcut/trusted-run',
    }))

    const result = await runWindowsCheck(
      [
        '--chrome', '/mnt/d/Chrome/chrome.exe',
        '--dist', '/repo/dist',
        '--media-1080', '/mnt/d/arbitrary/input.mp4',
        '--work-root', '/mnt/d/arbitrary/tailcut/self-certified',
        '--windows-temp', 'D:\\arbitrary',
      ],
      {
        defaultPaths,
        prepareRun,
        writeReport: async (): Promise<void> => undefined,
      },
    )

    expect(result.exitCode).not.toBe(0)
    expect(result.report.error).toMatchObject({ message: expect.stringMatching(/Windows Temp|run root/i) })
    expect(defaultPaths).toHaveBeenCalledTimes(1)
    expect(prepareRun).not.toHaveBeenCalled()
  })
})

describe('dry run', () => {
  it('prints the complete plan without touching runtime paths or side effects', async () => {
    const output: string[] = []
    const touched = vi.fn((name: string): never => {
      throw new Error(`dry run touched ${name}`)
    })
    const result = await runWindowsCheck(
      [
        '--dry-run',
        '--chrome',
        '/absent/chrome.exe',
        '--dist',
        '/absent/dist',
        '--media-1080',
        '/absent/minute.mp4',
        '--work-root',
        '/mnt/c/absent/tailcut/run-dry',
      ],
      {
        print: (line: string): void => {
          output.push(line)
        },
        readPath: async (): Promise<never> => touched('path'),
        writePath: async (): Promise<never> => touched('write'),
        bindPort: async (): Promise<never> => touched('port'),
        spawn: async (): Promise<never> => touched('process'),
      },
    )

    expect(result.exitCode).toBe(0)
    expect(touched).not.toHaveBeenCalled()
    const printed = output.join('\n')
    expect(printed).toMatch(/Chrome for Testing/i)
    expect(printed).toMatch(/copy.*dist/i)
    expect(printed).toMatch(/generate|media-1080|minute/i)
    expect(printed).toMatch(/ranged HTTP|Range/i)
    expect(printed).toMatch(/24.*probe|probe.*24/i)
    expect(printed).toMatch(/HEVC.*1080/i)
    expect(printed).toMatch(/128.*64/i)
    expect(printed).toMatch(/WebP.*10/i)
    expect(printed).toMatch(/report.*JSON|JSON.*report/i)
    expect(printed).toMatch(/Browser\.close/i)
    expect(printed).toContain('/absent/chrome.exe')
    expect(printed).toContain('/absent/dist')
    expect(printed).toContain('/absent/minute.mp4')
    expect(printed).toContain('/mnt/c/absent/tailcut/run-dry')
    expect(printed).toMatch(/9222|CDP port/i)
    expect(printed).toMatch(/downloads/i)
  })
})
