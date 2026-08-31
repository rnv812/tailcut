import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const readJson = async (file, label) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (cause) {
    throw new Error(`cannot read ${label} at ${file}`, { cause })
  }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

const crc32 = (bytes) => {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

export const filesBelow = async (directory, archivePrefix = '') => {
  const found = []
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    const archived = archivePrefix ? `${archivePrefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...await filesBelow(absolute, archived))
    else if (entry.isFile()) found.push({ absolute, archived })
    else throw new Error(`release tree contains a non-file entry: ${absolute}`)
  }

  return found
}

export const zipFiles = async (files) => {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const file of files) {
    const name = Buffer.from(file.archived, 'utf8')
    const original = await readFile(file.absolute)
    const compressed = deflateRawSync(original, { level: 9 })
    const crc = crc32(original)

    // Fixed 1980-01-01 timestamps make the archive reproducible for identical dist bytes.
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(33, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(original.length, 22)
    local.writeUInt16LE(name.length, 26)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(33, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(original.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)

    localParts.push(local, name, compressed)
    centralParts.push(central, name)
    offset += local.length + name.length + compressed.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...localParts, ...centralParts, end])
}

/**
 * Build one release archive whose top-level directory can be selected directly in Chrome's
 * "Load unpacked" dialog. Only dist is copied: repository files, dependencies, test output and
 * local configuration cannot leak into a release asset.
 */
export async function packageRelease(tag, options = {}) {
  if (Object.hasOwn(options, 'outputDir')) {
    throw new Error('release output is fixed at <root>/release; outputDir is not accepted')
  }

  const root = path.resolve(options.root ?? process.cwd())
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`release tag must look like v1.2.3, received ${JSON.stringify(tag)}`)
  }

  const packageJson = await readJson(path.join(root, 'package.json'), 'package.json')
  const sourceManifest = await readJson(path.join(root, 'manifest.json'), 'source manifest')
  const builtManifest = await readJson(path.join(root, 'dist', 'manifest.json'), 'built manifest')
  const expectedTag = `v${packageJson.version}`

  if (tag !== expectedTag) {
    throw new Error(`release tag ${tag} does not match package version ${packageJson.version}`)
  }
  if (sourceManifest.version !== packageJson.version) {
    throw new Error(
      `source manifest version ${sourceManifest.version} does not match package version ${packageJson.version}`,
    )
  }
  if (builtManifest.version !== packageJson.version) {
    throw new Error(
      `built manifest version ${builtManifest.version} does not match package version ${packageJson.version}`,
    )
  }

  const output = path.join(root, 'release')
  const folderName = `tailcut-${tag}-chrome`
  const folder = path.join(output, folderName)
  const zipName = `${folderName}.zip`
  const zip = path.join(output, zipName)
  const checksum = `${zip}.sha256`

  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  await cp(path.join(root, 'dist'), folder, { recursive: true })
  await writeFile(zip, await zipFiles(await filesBelow(folder, folderName)))

  const digest = createHash('sha256').update(await readFile(zip)).digest('hex')
  await writeFile(checksum, `${digest}  ${zipName}\n`)

  return { folder, zip, checksum }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2]
  if (!tag) throw new Error('usage: node tools/package-release.mjs v1.2.3')
  const result = await packageRelease(tag)
  console.log(`created ${path.relative(process.cwd(), result.zip)}`)
  console.log(`created ${path.relative(process.cwd(), result.checksum)}`)
}
