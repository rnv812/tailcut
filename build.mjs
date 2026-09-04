import * as esbuild from 'esbuild'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** MV3 workers must come from the extension package, rather than a generated blob URL. */
const packagedAacWorker = {
  name: 'packaged-aac-worker',
  setup(build) {
    build.onLoad({ filter: /mediabunny-aac-encoder\.mjs$/ }, async ({ path: file }) => {
      const code = await readFile(file, 'utf8')
      const start = code.indexOf('// inline-worker:')
      const end = code.indexOf('// packages/aac-encoder/src/encoder.ts', start)
      const factory = code.slice(start, end).match(/function (\w+)\(\) \{\s*return inlineWorker/)
      if (start < 0 || end < 0 || !factory) throw new Error('The AAC worker bundle layout changed.')
      return {
        contents: code.slice(0, start) +
          `function ${factory[1]}() { return new Worker(chrome.runtime.getURL('shared/aac-worker.js')); }\n` +
          code.slice(end),
        loader: 'js',
      }
    })
    build.onResolve({ filter: /^\.\.\/build\/aac$/ }, () => ({
      path: path.resolve('node_modules/@mediabunny/aac-encoder/dist/modules/build/aac.js'),
    }))
    build.onLoad({ filter: /aac-encoder\/dist\/modules\/build\/aac\.js$/ }, async ({ path: file }) => ({
      // The published module mixes CommonJS exports with import.meta. Restore its ESM export.
      contents: (await readFile(file, 'utf8'))
        .replace('Object.defineProperty(exports, "__esModule", { value: true });', '')
        .replace('exports.default = Module;', 'export default Module;'),
      loader: 'js',
    }))
  },
}

/**
 * Output syntax. This matches the manifest's `minimum_chrome_version`: Chrome will not install
 * the extension below that version and must parse everything the bundler emits at or above it.
 */
export const TARGET = 'chrome120'

/**
 * Entry points and their formats. Format is not merely a build detail: Chrome loads content
 * scripts only as classic scripts, while a service worker is a module only when the manifest
 * declares `"type": "module"`. `tests/build/dist.test.ts` catches any mismatch between the
 * manifest and the bundle format.
 */
export const ENTRIES = [
  { entryPoints: { 'page/main-hook': 'src/page/main-hook.ts' }, format: 'iife' },
  { entryPoints: { 'page/content': 'src/page/content.ts' }, format: 'iife' },
  { entryPoints: { 'sw/service-worker': 'src/sw/service-worker.ts' }, format: 'esm' },
  { entryPoints: { 'sw/sweeper': 'src/sw/sweeper.ts' }, format: 'esm' },
  { entryPoints: { 'bridge/bridge': 'src/bridge/bridge.ts' }, format: 'esm' },
  { entryPoints: { 'bridge/snapshot-worker': 'src/bridge/snapshot-worker.ts' }, format: 'iife' },
  { entryPoints: { 'bridge/history-worker': 'src/bridge/history-worker.ts' }, format: 'iife' },
  { entryPoints: { 'shared/history-db': 'src/shared/history-db.ts' }, format: 'esm' },
  { entryPoints: { 'shared/settings-store': 'src/shared/settings-store.ts' }, format: 'esm' },
  { entryPoints: { 'shared/convert-mp4': 'src/shared/convert-mp4.ts' }, format: 'esm' },
  {
    entryPoints: { 'shared/aac-worker': 'node_modules/@mediabunny/aac-encoder/src/encode.worker.ts' },
    format: 'iife',
  },
  { entryPoints: { 'popup/popup': 'src/popup/popup.tsx' }, format: 'esm' },
  { entryPoints: { 'options/options': 'src/options/options.tsx' }, format: 'esm' },
  { entryPoints: { 'editor/main': 'src/editor/main.tsx' }, format: 'esm' },
  { entryPoints: { 'editor/waveform-worker': 'src/editor/source/waveform-worker.ts' }, format: 'iife' },
]

/** Complete esbuild options, one set per entry point. */
export function buildOptions(dev) {
  return ENTRIES.map((entry) => ({
    bundle: true,
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    target: TARGET,
    logLevel: 'info',
    outdir: 'dist',
    plugins: [packagedAacWorker],
    ...entry,
  }))
}

export async function build({ dev = false, watch = false } = {}) {
  // Every build starts with an empty dist directory so an artifact from a renamed entry point
  // cannot survive into the shipped extension.
  await rm('dist', { recursive: true, force: true })
  await mkdir('dist', { recursive: true })

  const contexts = []
  for (const options of buildOptions(dev)) {
    if (watch) contexts.push(await esbuild.context(options))
    else await esbuild.build(options)
  }

  await cp('manifest.json', 'dist/manifest.json')
  await cp('src/bridge/bridge.html', 'dist/bridge/bridge.html')
  await cp('src/popup/popup.html', 'dist/popup/popup.html')
  await cp('src/options/options.html', 'dist/options/options.html')
  await cp('src/editor/editor.html', 'dist/editor/editor.html')
  await mkdir('dist/assets/tailcut/icon', { recursive: true })
  await mkdir('dist/assets/tailcut/svg', { recursive: true })
  await mkdir('dist/shared', { recursive: true })
  for (const size of [16, 32, 48, 128]) {
    await cp(`assets/tailcut/icon/icon-${size}.png`, `dist/assets/tailcut/icon/icon-${size}.png`)
  }
  await cp('assets/tailcut/svg/mark-light.svg', 'dist/assets/tailcut/svg/mark-light.svg')
  await cp('src/shared/theme.css', 'dist/shared/theme.css')
  await mkdir('dist/licenses', { recursive: true })
  await cp('node_modules/mediabunny/LICENSE', 'dist/licenses/mediabunny-MPL-2.0.txt')
  await cp('node_modules/@mediabunny/aac-encoder/README.md', 'dist/licenses/aac-encoder-source.md')
  await cp('licenses', 'dist/licenses', { recursive: true })

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()))
    console.log('watching…')
  }
}

// Importing this file exposes configuration only; executing it as a script starts a build.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const watch = process.argv.includes('--watch')
  await build({ watch, dev: watch || process.argv.includes('--dev') })
}
