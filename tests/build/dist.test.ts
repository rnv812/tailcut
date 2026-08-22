import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { stdio: 'pipe' })
}, 120_000)

const manifest = () => JSON.parse(readFileSync('dist/manifest.json', 'utf8'))

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
})

describe('манифест', () => {
  it('хук объявлен в MAIN world и стартует до скриптов страницы', () => {
    const hook = manifest().content_scripts.find((c: { js: string[] }) =>
      c.js.includes('page/main-hook.js'),
    )
    expect(hook, 'content script с хуком не найден').toBeTruthy()
    expect(hook.world).toBe('MAIN')
    expect(hook.run_at).toBe('document_start')
    expect(hook.all_frames).toBe(true)
  })

  it('наблюдатель живёт в изолированном мире', () => {
    const content = manifest().content_scripts.find((c: { js: string[] }) =>
      c.js.includes('page/content.js'),
    )
    expect(content.world).toBe('ISOLATED')
    expect(content.run_at).toBe('document_start')
  })

  it('мост доступен со стороны любой страницы', () => {
    const war = manifest().web_accessible_resources[0]
    expect(war.resources).toContain('bridge/bridge.html')
    expect(war.matches).toContain('<all_urls>')
  })
})
