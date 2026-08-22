import * as esbuild from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'

const watch = process.argv.includes('--watch')
const dev = watch || process.argv.includes('--dev')

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })

const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  target: 'chrome120',
  logLevel: 'info',
}

const builds = [
  { entryPoints: { 'page/main-hook': 'src/page/main-hook.ts' }, format: 'iife' },
  { entryPoints: { 'page/content': 'src/page/content.ts' }, format: 'iife' },
  { entryPoints: { 'sw/service-worker': 'src/sw/service-worker.ts' }, format: 'esm' },
  { entryPoints: { 'bridge/bridge': 'src/bridge/bridge.ts' }, format: 'esm' },
  { entryPoints: { 'popup/popup': 'src/popup/popup.tsx' }, format: 'esm' },
]

const contexts = []
for (const b of builds) {
  const options = { ...common, ...b, outdir: 'dist' }
  if (watch) contexts.push(await esbuild.context(options))
  else await esbuild.build(options)
}

async function copyStatic() {
  await cp('manifest.json', 'dist/manifest.json')
  await cp('src/bridge/bridge.html', 'dist/bridge/bridge.html')
  await cp('src/popup/popup.html', 'dist/popup/popup.html')
}
await copyStatic()

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('watching…')
}
