import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The implementation is an executable ESM tool. TypeScript does not derive declarations from
// `.mjs`; the behavioral contract below is the declaration that matters for this internal tool.
// @ts-expect-error No declaration file exists for the executable module.
const { packageRelease } = await import('../../tools/package-release.mjs')

const roots: string[] = []

const zipEntries = (archive: Buffer): string[] => {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const end = archive.lastIndexOf(endSignature)
  if (end < 0) throw new Error('ZIP end record is missing')

  const count = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  const entries: string[] = []

  for (let index = 0; index < count; index += 1) {
    expect(archive.readUInt32LE(offset)).toBe(0x02014b50)
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    entries.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tailcut-release-'))
  roots.push(root)
  await mkdir(path.join(root, 'dist', 'editor'), { recursive: true })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }))
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ version: '0.1.0' }))
  await writeFile(path.join(root, 'dist', 'manifest.json'), JSON.stringify({ version: '0.1.0' }))
  await writeFile(path.join(root, 'dist', 'editor', 'main.js'), 'export const ready = true\n')
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('release packaging', () => {
  it('archives only the installable dist tree inside one selectable directory', async () => {
    const root = await fixture()

    const result = await packageRelease('v0.1.0', { root })
    const entries = zipEntries(await readFile(result.zip))

    expect(entries).toContain('tailcut-v0.1.0-chrome/manifest.json')
    expect(entries).toContain('tailcut-v0.1.0-chrome/editor/main.js')
    expect(entries.some((entry) => entry.endsWith('/package.json'))).toBe(false)
    expect(entries.some((entry) => entry.includes('node_modules'))).toBe(false)
  })

  it('writes a checksum that verifies the downloadable zip', async () => {
    const root = await fixture()

    const result = await packageRelease('v0.1.0', { root })
    const zip = await readFile(result.zip)
    const expected = `${createHash('sha256').update(zip).digest('hex')}  ${path.basename(result.zip)}\n`

    expect(await readFile(result.checksum, 'utf8')).toBe(expected)
  })

  it('refuses a tag or manifest that disagrees with the package version', async () => {
    const root = await fixture()

    await expect(packageRelease('v0.2.0', { root })).rejects.toThrow(/package version/i)

    await writeFile(path.join(root, 'dist', 'manifest.json'), JSON.stringify({ version: '9.9.9' }))
    await expect(packageRelease('v0.1.0', { root })).rejects.toThrow(/built manifest/i)
  })

  it('never accepts a caller-selected directory as its recursive cleanup target', async () => {
    const root = await fixture()

    await expect(packageRelease('v0.1.0', { root, outputDir: '.' })).rejects.toThrow(
      /output.*fixed|outputDir/i,
    )

    expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version).toBe('0.1.0')
    expect(JSON.parse(await readFile(path.join(root, 'dist', 'manifest.json'), 'utf8')).version).toBe(
      '0.1.0',
    )
  })
})
