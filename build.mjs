import * as esbuild from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * Синтаксис вывода. Привязан к `minimum_chrome_version` из манифеста: ниже этой версии
 * Chrome расширение не ставит, выше — обязан разобрать всё, что выпустил бандлер.
 */
export const TARGET = 'chrome120'

/**
 * Точки входа и формат каждой. Формат — не деталь сборки: content-скрипты Chrome грузит
 * только классическим скриптом, а service worker — модулем лишь при `"type": "module"`
 * в манифесте. Расхождение манифеста и формата бандла ловится в tests/build/dist.test.ts.
 */
export const ENTRIES = [
  { entryPoints: { 'page/main-hook': 'src/page/main-hook.ts' }, format: 'iife' },
  { entryPoints: { 'page/content': 'src/page/content.ts' }, format: 'iife' },
  { entryPoints: { 'sw/service-worker': 'src/sw/service-worker.ts' }, format: 'esm' },
  { entryPoints: { 'bridge/bridge': 'src/bridge/bridge.ts' }, format: 'esm' },
  { entryPoints: { 'bridge/snapshot-worker': 'src/bridge/snapshot-worker.ts' }, format: 'iife' },
  { entryPoints: { 'popup/popup': 'src/popup/popup.tsx' }, format: 'esm' },
  { entryPoints: { 'editor/main': 'src/editor/main.tsx' }, format: 'esm' },
]

/** Полные опции esbuild по одной на точку входа. */
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
  // Сборка всегда начинается с пустого dist: артефакт переименованной точки входа иначе
  // доживает до поставки.
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
  await cp('src/editor/editor.html', 'dist/editor/editor.html')

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()))
    console.log('watching…')
  }
}

// Импорт этого файла отдаёт только конфигурацию; собирает — запуск как скрипта.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const watch = process.argv.includes('--watch')
  await build({ watch, dev: watch || process.argv.includes('--dev') })
}
