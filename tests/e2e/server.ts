import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

/**
 * A real host, because a plain source is the one case a routed answer cannot stand in for.
 *
 * Everything else in this suite is served by `page.route`, which fulfils a request inside the
 * page's own network. A plain source is read from the extension frame instead — that is the whole
 * point of it, and the reads carry `Range` headers whose answers have to be genuine 206s with a
 * `Content-Range`. So the fixtures are put behind an ordinary HTTP server and the browser talks
 * to it the way it talks to a CDN.
 *
 * The page and the media get a server each, so that they sit on two origins. That is the shape
 * the survey found — the media of eighteen live pages of twenty-one sits on a CDN of another
 * origin, and 48 of 57 ranged fetches from the page were refused for it — and it is the reason
 * the reads live in the extension frame at all. A one-origin test would pass whether or not any
 * of that was true.
 */
export interface Host {
  origin: string
  /** Every `Range` header the host was asked for, in order; null for a request without one. */
  asked: Array<string | null>
  /** Bytes the host has handed over, all requests together. */
  served: number
  close: () => Promise<void>
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{
  server: Server
  origin: string
}> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return { server, origin: `http://127.0.0.1:${port}` }
}

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })

/**
 * What a file is served as, by the extension it is named with.
 *
 * It has to be right and not merely plausible: a `<video>` handed a Matroska under `video/mp4`
 * refuses to play it, and an `<audio>` handed an mp3 under a video type does the same.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
}

/**
 * Serves the files of `tests/fixtures/plain` and answers ranged reads properly.
 *
 * No `Access-Control-Allow-Origin` on purpose. A media element needs none to play a file, and a
 * `fetch` from the page is refused without one — which is the refusal the extension frame is
 * there to get around, and which plain.spec.ts checks for rather than takes on trust.
 *
 * The content type is taken from the name because it has to be right: a `<video>` given a
 * Matroska under `video/mp4` refuses to play it, and the whole of what these tests watch is a
 * browser really playing a file.
 */
export async function serveMedia(): Promise<Host> {
  const host: Host = { origin: '', asked: [], served: 0, close: async () => {} }

  const { server, origin } = await listen(async (request, response) => {
    const name = path.basename(new URL(request.url ?? '/', 'http://x').pathname)
    const range = request.headers.range ?? null
    host.asked.push(range)

    let file: Buffer
    try {
      file = await readFile(path.resolve('tests/fixtures/plain', name))
    } catch {
      response.writeHead(404).end('no such file')
      return
    }

    const contentType = CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'video/mp4'

    const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '')
    if (!match) {
      response.writeHead(200, {
        'content-type': contentType,
        'content-length': String(file.byteLength),
        'accept-ranges': 'bytes',
      })
      host.served += file.byteLength
      response.end(file)
      return
    }

    const from = Number(match[1])
    const to = match[2] ? Math.min(Number(match[2]), file.byteLength - 1) : file.byteLength - 1
    const part = file.subarray(from, to + 1)

    response.writeHead(206, {
      'content-type': contentType,
      'content-length': String(part.byteLength),
      // The one field a reader can trust on a 206: `Accept-Ranges` is not reliably present on one.
      'content-range': `bytes ${from}-${to}/${file.byteLength}`,
    })

    host.served += part.byteLength
    response.end(part)
  })

  host.origin = origin
  host.close = () => close(server)
  return host
}

/**
 * Serves one page, under an origin of its own, with the address of the media written into it.
 *
 * `sound` is for the one page shape that plays two files at once — a picture in a `<video>` and a
 * soundtrack in an `<audio>` beside it (§5.6). Both come off the same media host, which is what
 * the survey found: the two files of coub sit on hosts of their own, and neither is the page's.
 */
export async function servePage(
  html: string,
  mediaOrigin: string,
  file: string,
  sound?: string,
): Promise<Host> {
  const host: Host = { origin: '', asked: [], served: 0, close: async () => {} }

  const { server, origin } = await listen(async (request, response) => {
    host.asked.push(request.headers.range ?? null)

    const page = await readFile(path.resolve('tests/e2e/page', html), 'utf8')
    // Every occurrence and not the first: a page that hangs one file on two elements writes the
    // address twice, and half a substitution would leave the second element pointing at nothing.
    const body = page
      .replaceAll('__MEDIA__', `${mediaOrigin}/${file}`)
      .replaceAll('__SOUND__', sound ? `${mediaOrigin}/${sound}` : '')
      .replaceAll('__NAME__', file)

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    host.served += body.length
    response.end(body)
  })

  host.origin = origin
  host.close = () => close(server)
  return host
}
