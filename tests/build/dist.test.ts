import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { Script } from 'node:vm'

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { stdio: 'pipe' })
}, 120_000)

const manifest = () => JSON.parse(readFileSync('dist/manifest.json', 'utf8'))

type ContentScript = {
  matches: string[]
  js: string[]
  run_at: string
  world: string
  all_frames: boolean
}

const contentScript = (js: string): ContentScript => {
  const declared: ContentScript[] = manifest().content_scripts
  const found = declared.find((c) => c.js.includes(js))
  if (!found) throw new Error(`content script ${js} не объявлен в манифесте`)
  return found
}

const distScripts = (): string[] =>
  readdirSync('dist', { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.js'))
    .sort()

// Статические import/export … from "…" и side-effect import "…" на верхнем уровне бандла.
const STATIC_IMPORT =
  /(?:^|[;}])\s*(?:import|export)\b[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[;}])\s*import\s*['"]([^'"]+)['"]/g

const importedSpecifiers = (code: string): string[] => {
  const found: string[] = []
  for (const m of code.matchAll(STATIC_IMPORT)) {
    const spec = m[1] ?? m[2]
    if (spec !== undefined) found.push(spec)
  }
  return found
}

// Голый спецификатор — тот, что Chrome не может разрешить без сборщика: не относительный,
// не абсолютный путь и не URL со схемой.
const isBareSpecifier = (spec: string): boolean => !/^(?:\.{1,2}\/|\/|[a-zA-Z][\w+.-]*:)/.test(spec)

describe('сборка', () => {
  it('кладёт в dist каждый файл, на который ссылается манифест', () => {
    const m = manifest()
    const referenced: string[] = [
      m.background.service_worker,
      m.action.default_popup,
      ...m.content_scripts.flatMap((c: { js: string[] }) => c.js),
      ...m.web_accessible_resources.flatMap((w: { resources: string[] }) => w.resources),
    ]

    expect(referenced.length).toBeGreaterThan(5)
    for (const rel of referenced) {
      expect(existsSync(`dist/${rel}`), `dist/${rel} отсутствует`).toBe(true)
    }
  })

  it('страницы попадают в сборку вместе со своими скриптами', () => {
    expect(existsSync('dist/popup/popup.js')).toBe(true)
    expect(existsSync('dist/bridge/bridge.js')).toBe(true)
  })

  it('в собранных скриптах не осталось импортов голых спецификаторов', () => {
    const scripts = distScripts()
    expect(scripts).toContain('popup/popup.js')
    expect(scripts).toContain('bridge/bridge.js')

    const bare = scripts.flatMap((rel) =>
      importedSpecifiers(readFileSync(`dist/${rel}`, 'utf8'))
        .filter(isBareSpecifier)
        .map((spec) => `${rel}: import "${spec}"`),
    )

    expect(bare, 'зависимости не вшиты в бандл — Chrome такой файл не загрузит').toEqual([])
  })

  it('content-скрипты собраны классическим скриптом, а не модулем', () => {
    for (const rel of ['page/main-hook.js', 'page/content.js']) {
      const code = readFileSync(`dist/${rel}`, 'utf8')

      // Классический скрипт с import/export — SyntaxError уже на разборе.
      expect(
        () => new Script(code, { filename: rel }),
        `${rel}: не разбирается как классический скрипт`,
      ).not.toThrow()

      expect(code, `${rel}: нет директивы и обёртки IIFE в начале`).toMatch(
        /^"use strict";\s*\(\s*\(\s*\)\s*=>\s*\{/,
      )
      expect(code.trimEnd(), `${rel}: обёртка IIFE не закрыта`).toMatch(/\}\)\(\);$/)
    }
  })
})

describe('манифест', () => {
  it('хук объявлен в MAIN world и стартует до скриптов страницы', () => {
    const hook = contentScript('page/main-hook.js')
    expect(hook.world).toBe('MAIN')
    expect(hook.run_at).toBe('document_start')
    expect(hook.all_frames).toBe(true)
  })

  it('наблюдатель живёт в изолированном мире', () => {
    const content = contentScript('page/content.js')
    expect(content.world).toBe('ISOLATED')
    expect(content.run_at).toBe('document_start')
    expect(content.all_frames).toBe(true)
  })

  it('оба content-скрипта объявлены для всех сайтов, без привязки к домену', () => {
    expect(contentScript('page/main-hook.js').matches).toEqual(['<all_urls>'])
    expect(contentScript('page/content.js').matches).toEqual(['<all_urls>'])
  })

  it('мост доступен со стороны любой страницы', () => {
    const war = manifest().web_accessible_resources[0]
    expect(war.resources).toContain('bridge/bridge.html')
    expect(war.matches).toContain('<all_urls>')
  })

  it('описание совпадает с описанием пакета и не пустое', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

    expect(typeof pkg.description).toBe('string')
    expect(pkg.description.trim().length).toBeGreaterThan(0)
    expect(manifest().description).toBe(pkg.description)
  })
})
