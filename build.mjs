import * as esbuild from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

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
