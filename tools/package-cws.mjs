import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { filesBelow, zipFiles } from './package-release.mjs'

const run = promisify(execFile)

const readJson = async (file, label) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (cause) {
    throw new Error(`cannot read ${label} at ${file}`, { cause })
  }
}

const removeCwsArchives = async (root) => {
  const output = path.join(root, 'release')
  let entries
  try {
    entries = await readdir(output, { withFileTypes: true })
  } catch (cause) {
    if (cause?.code === 'ENOENT') return
    throw cause
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^tailcut-v.+-cws\.zip$/.test(entry.name))
      .map((entry) => rm(path.join(output, entry.name), { force: true })),
  )
}

const buildProject = async (root) => {
  await run(process.execPath, [path.join(root, 'build.mjs')], { cwd: root })
}

export async function packageChromeWebStore(options = {}) {
  const root = path.resolve(options.root ?? process.cwd())
  await removeCwsArchives(root)

  try {
    await (options.build ?? buildProject)(root)

    const packageJson = await readJson(path.join(root, 'package.json'), 'package.json')
    const sourceManifest = await readJson(path.join(root, 'manifest.json'), 'source manifest')
    const manifest = await readJson(path.join(root, 'dist', 'manifest.json'), 'built manifest')
    if (sourceManifest.version !== packageJson.version) {
      throw new Error(
        `source manifest version ${sourceManifest.version} does not match package version ${packageJson.version}`,
      )
    }
    if (manifest.version !== packageJson.version) {
      throw new Error(
        `built manifest version ${manifest.version} does not match package version ${packageJson.version}`,
      )
    }

    const output = path.join(root, 'release')
    const zip = path.join(output, `tailcut-v${packageJson.version}-cws.zip`)
    const files = await filesBelow(path.join(root, 'dist'))

    if (!files.some((file) => file.archived === 'manifest.json')) {
      throw new Error('dist/manifest.json is missing from the Chrome Web Store package')
    }

    await mkdir(output, { recursive: true })
    await writeFile(zip, await zipFiles(files))
    return zip
  } catch (cause) {
    await removeCwsArchives(root)
    throw cause
  }
}

const rootArgument = (arguments_) => {
  if (arguments_.length === 0) return undefined
  if (arguments_.length === 2 && arguments_[0] === '--root' && arguments_[1]) {
    return arguments_[1]
  }
  throw new Error('usage: node tools/package-cws.mjs [--root <project-directory>]')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const zip = await packageChromeWebStore({ root: rootArgument(process.argv.slice(2)) })
  console.log(`created ${path.relative(process.cwd(), zip)}`)
}
