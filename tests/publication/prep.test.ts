import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The implementation is an executable ESM tool without a TypeScript declaration. This test
// defines its behavioral contract and also checks the npm command that exposes it below.
// @ts-expect-error No declaration file exists for the executable module.
const { packageChromeWebStore } = await import('../../tools/package-cws.mjs')

const projectFile = async (relative: string): Promise<string> => {
  try {
    return await readFile(relative, 'utf8')
  } catch {
    return ''
  }
}

const zipEntries = (archive: Buffer): string[] => {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const end = archive.lastIndexOf(endSignature)
  if (end < 0) throw new Error('ZIP end record is missing')

  const count = archive.readUInt16LE(end + 10)
  let offset = archive.readUInt32LE(end + 16)
  const entries: string[] = []

  for (let index = 0; index < count; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`ZIP central-directory entry ${index} is malformed`)
    }
    const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    entries.push(archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
    offset += 46 + nameLength + extraLength + commentLength
  }

  return entries
}

describe('publication legal documents', () => {
  it('provides terms for authorized use, protected media, site rules, and warranty', async () => {
    const terms = await projectFile('TERMS.md')

    expect(terms, 'TERMS.md must exist').not.toBe('')
    expect(terms, 'users must be limited to material they own or are authorized to use').toMatch(
      /(?:own|rights holder).*(?:permission|authori[sz]ed)|authori[sz]ed.*(?:content|material)/is,
    )
    expect(terms, 'the terms must say that tailcut does not bypass or decrypt DRM').toMatch(
      /(?:does not|will not).*(?:bypass|circumvent|decrypt).*(?:DRM|protected|encrypted)/is,
    )
    expect(terms, 'users must remain responsible for each website\'s terms').toMatch(
      /(?:comply with|responsible for).*(?:site|website|platform).*(?:terms|rules|conditions)/is,
    )
    expect(terms, 'the software must be supplied without warranty').toMatch(
      /(?:as is|without warrant)/i,
    )
  })

  it('versions the terms accepted by the extension', async () => {
    const terms = await projectFile('TERMS.md')

    expect(terms).toContain('Terms version: 1')
    expect(terms).toContain('Effective date: 31 August 2026')
  })

  it('limits technical refusal to detected encrypted or DRM-protected media', async () => {
    const terms = await projectFile('TERMS.md')

    expect(terms).toContain(
      'tailcut does not bypass or circumvent access controls or paywalls. When tailcut detects encrypted or DRM-protected media, it refuses that media rather than recording it.',
    )
  })

  it('contains the exact Chrome Web Store Limited Use affirmation', async () => {
    const privacy = await projectFile('PRIVACY.md')

    expect(privacy).toContain(
      'The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.',
    )
  })

  it('states exactly who cannot access locally handled user data without denying media-host requests', async () => {
    const privacy = await projectFile('PRIVACY.md')

    expect(privacy).toContain(
      'No human working on tailcut, including the developer, can access captured media, browsing activity, settings, or editing data because tailcut never sends that data to them.',
    )
    expect(privacy).toContain(
      'The website or media host can receive the bounded byte-range requests described below, just as it receives requests from its own player.',
    )
  })
})

describe('Chrome Web Store listing source of truth', () => {
  const listing = () => projectFile('docs/chrome-web-store-listing.md')

  it('identifies itself as the submission source of truth', async () => {
    expect(await listing()).toContain(
      'This file is the source of truth for the Chrome Web Store listing and reviewer submission.',
    )
  })

  it('states one narrow purpose', async () => {
    const document = await listing()

    expect(document).toMatch(/^## Single purpose$/m)
    expect(document).toMatch(/already-(?:buffered|viewed|watched).*(?:video|media).*(?:clip|save|export)/is)
  })

  it('provides the prominent data disclosure shown before installation', async () => {
    const document = await listing()

    expect(document).toMatch(/^## Prominent data disclosure$/m)
    expect(document).toMatch(/before (?:install|installation)/i)
    expect(document).toMatch(/video|audio/i)
    expect(document).toMatch(/(?:page title|hostname|media URL|browsing activity)/i)
    expect(document).toMatch(/(?:stays|stored|processed).*(?:device|locally)/is)
  })

  it('justifies every requested permission and all-sites access', async () => {
    const document = await listing()

    expect(document).toMatch(/^## Permission justifications$/m)
    for (const permission of ['storage', 'downloads', 'scripting', 'alarms', '<all_urls>']) {
      expect(document, `${permission} needs a reviewer-facing justification`).toContain(permission)
    }
    expect(document).toContain(
      'By default, tailcut observes video players on all sites you visit.',
    )
  })

  it('gives a reviewer a complete acceptance path', async () => {
    const document = await listing()

    expect(document).toMatch(/^## Reviewer steps$/m)
    expect(document).toMatch(/(?:install|load).*(?:extension|zip)/is)
    expect(document).toMatch(/(?:open|play).*(?:video|fixture)/is)
    expect(document).toMatch(/(?:popup|toolbar).*(?:record|capture)/is)
    expect(document).toMatch(/(?:save|edit|export)/i)
    expect(document).toMatch(/(?:DRM|protected|encrypted).*(?:refus|not captured|not recorded)/is)
  })

  it('explains that the package contains all executable code', async () => {
    const document = await listing()

    expect(document).toMatch(/^## Remote code$/m)
    expect(document).toMatch(/(?:all|every).*(?:executable code|JavaScript).*(?:package|bundle|zip)/is)
    expect(document).toMatch(/(?:does not|no).*(?:remote code|remotely hosted code|download.*executable)/is)
  })

  it('disclaims copyright permission and DRM circumvention', async () => {
    const document = await listing()

    expect(document).toMatch(/^## Copyright and authorized use$/m)
    expect(document).toMatch(/(?:own|permission|authori[sz]ed).*(?:content|material|media)/is)
    expect(document).toMatch(/(?:does not|will not).*(?:bypass|circumvent|decrypt).*(?:DRM|protected|encrypted)/is)
    expect(document).toMatch(/(?:site|website|platform).*(?:terms|rules|conditions)/is)
  })

  it('uses donation wording that promises no benefit in exchange', async () => {
    const document = await listing()

    expect(document).toMatch(/^## Donation$/m)
    expect(document).toContain(
      'Support tailcut with a voluntary donation via Donatty. Donations do not unlock features, licenses, support priority, or any other benefit.',
    )
  })

  it('records the exact public privacy-policy URL submitted to the store', async () => {
    expect(await listing()).toContain(
      'https://github.com/rnv812/tailcut/blob/master/PRIVACY.md',
    )
  })
})

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Chrome Web Store package', () => {
  const missing = async (file: string): Promise<boolean> => {
    try {
      await access(file)
      return false
    } catch {
      return true
    }
  }

  it('is exposed as an npm command, builds first, and puts manifest.json at the ZIP root', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts?: Record<string, string>
    }
    const command = packageJson.scripts?.['package:cws']

    expect(command, 'package.json must expose npm run package:cws').toBe('node tools/package-cws.mjs')

    const root = await mkdtemp(path.join(os.tmpdir(), 'tailcut-cws-'))
    temporaryRoots.push(root)
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }))
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ version: '0.1.0' }))

    let built = false
    const build = async (): Promise<void> => {
      built = true
      await mkdir(path.join(root, 'dist', 'editor'), { recursive: true })
      await writeFile(path.join(root, 'dist', 'manifest.json'), JSON.stringify({ version: '0.1.0' }))
      await writeFile(path.join(root, 'dist', 'editor', 'main.js'), 'export const ready = true\n')
    }

    await packageChromeWebStore({ root, build })
    expect(built, 'the CWS command must build before it reads dist').toBe(true)

    const archive = await readFile(path.join(root, 'release', 'tailcut-v0.1.0-cws.zip'))
    const entries = zipEntries(archive)

    expect(entries).toContain('manifest.json')
    expect(entries).toContain('editor/main.js')
    expect(entries.some((entry) => entry.endsWith('/manifest.json'))).toBe(false)
    expect(entries.some((entry) => entry === 'package.json')).toBe(false)
  })

  it('removes every stale CWS ZIP when the build fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tailcut-cws-'))
    temporaryRoots.push(root)
    const output = path.join(root, 'release')
    const current = path.join(output, 'tailcut-v0.1.0-cws.zip')
    const older = path.join(output, 'tailcut-v0.0.9-cws.zip')

    await mkdir(output, { recursive: true })
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }))
    await writeFile(current, 'stale current package')
    await writeFile(older, 'stale older package')

    await expect(
      packageChromeWebStore({
        root,
        build: async () => {
          throw new Error('build failed')
        },
      }),
    ).rejects.toThrow('build failed')

    expect(await missing(current), 'a failed build left the current stale ZIP behind').toBe(true)
    expect(await missing(older), 'a failed build left an older stale ZIP behind').toBe(true)
  })
})
