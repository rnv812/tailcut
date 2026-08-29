import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { BRIDGE_PATH, EDITOR_PATH } from '../../src/shared/protocol'

/**
 * Сборка идёт под собственным таймаутом, заведомо меньшим хукового: тогда и зависшая сборка
 * приходит ловимым исключением, а не срывом хука.
 */
const BUILD_TIMEOUT_MS = 120_000

const buildFailureText = (cause: unknown): string => {
  const stderr = (cause as { stderr?: { toString(): string } }).stderr?.toString().trim()
  return [String(cause), stderr].filter(Boolean).join('\n')
}

let buildFailure: Error | undefined

beforeAll(() => {
  try {
    // Сборка идёт с нуля: на прогретом dist набор проверял бы пересборку поверх готового
    // дерева и не заметил бы, что на чистом клоне сборка вообще не запускается.
    rmSync('dist', { recursive: true, force: true })
    execFileSync('npm', ['run', 'build'], { stdio: 'pipe', timeout: BUILD_TIMEOUT_MS })
  } catch (cause) {
    buildFailure = new Error(`сборка не состоялась, проверять нечего:\n${buildFailureText(cause)}`)
  }
}, BUILD_TIMEOUT_MS + 30_000)

/**
 * Несостоявшаяся сборка обязана валить каждый тест. Брошенное прямо из beforeAll исключение
 * увело бы весь набор в skipped: ни одной проверки не выполнено, но и ни одна не красная —
 * покрытие молча вырождается в ноль.
 */
beforeEach(() => {
  if (buildFailure) throw buildFailure
})

const manifest = () => JSON.parse(readFileSync('dist/manifest.json', 'utf8'))
const packageJson = () => JSON.parse(readFileSync('package.json', 'utf8'))

type EntryOptions = {
  entryPoints: Record<string, string>
  format: string
  minify: boolean
  target: string
}

/**
 * Конфигурация сборки, прочитанная из самого build.mjs: импорт отдаёт только её, собирает
 * скрипт лишь при запуске из командной строки. Спецификатор вычисляемый, потому что build.mjs
 * не типизирован — контракт задан типом EntryOptions выше.
 */
const BUILD_SCRIPT = new URL('../../build.mjs', import.meta.url).href

const buildOptions = async (dev: boolean): Promise<EntryOptions[]> => {
  const script: { buildOptions(dev: boolean): EntryOptions[] } = await import(BUILD_SCRIPT)
  return script.buildOptions(dev)
}

const optionsFor = async (entry: string): Promise<EntryOptions> => {
  const found = (await buildOptions(false)).find((o) => entry in o.entryPoints)
  if (!found) throw new Error(`точка входа ${entry} не собирается`)
  return found
}

/** Скрипты, которые сборка обязана положить в dist, — по одному на точку входа. */
const shippedScripts = async (): Promise<string[]> =>
  (await buildOptions(false))
    .flatMap((o) => Object.keys(o.entryPoints).map((entry) => `${entry}.js`))
    .sort()

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

// Начало обёртки, в которую esbuild укладывает бандл формата iife.
const IIFE_WRAPPER_START = /^"use strict";\s*\(\s*\(\s*\)\s*=>\s*\{/

/**
 * Пространства chrome.*, которые MV3 отдаёт только по одноимённому разрешению: без строки
 * в permissions такое пространство в рантайме просто undefined, и вызов падает.
 */
const GATED_APIS = new Set([
  'alarms', 'bookmarks', 'contextMenus', 'cookies', 'declarativeNetRequest', 'downloads',
  'history', 'idle', 'management', 'notifications', 'offscreen', 'scripting', 'storage',
  'tabCapture', 'topSites', 'webNavigation', 'webRequest',
])

/** Пространства chrome.*, к которым обращается код расширения. */
const chromeApisUsedInSrc = (): string[] => {
  const namespaces = new Set<string>()

  for (const rel of readdirSync('src', { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(rel)) continue
    for (const m of readFileSync(`src/${rel}`, 'utf8').matchAll(/\bchrome\.([A-Za-z]\w*)\b/g)) {
      namespaces.add(m[1]!)
    }
  }

  return [...namespaces].sort()
}

/**
 * Файл content-скрипта → мир, в котором он обязан исполняться. Мир задаёт роль: из MAIN виден
 * и подменяем MSE самой страницы, из ISOLATED — только собственные объекты расширения.
 */
const CONTENT_SCRIPT_WORLDS: Record<string, string> = {
  'page/main-hook.js': 'MAIN',
  'page/content.js': 'ISOLATED',
}

/**
 * Разрешение → способность, на которой оно держится. Уходит способность — уходит разрешение,
 * и наоборот: без строки в permissions способности в рантайме не существует.
 */
const REQUIRED_PERMISSIONS: Record<string, string> = {
  activeTab: 'попап дотягивается до вкладки, на которой стоит пользователь',
  alarms: 'бейдж пересчитывается и после того, как service worker уснул',
  downloads: 'готовый клип сохраняется файлом — то, ради чего расширение и существует',
  scripting: 'попап и бейдж перечисляют фреймы вкладки, чтобы спросить каждый',
  storage: 'реестр сессий и правила доменов переживают смерть service worker',
}

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

  it('ships the editor page and its script', () => {
    // The popup opens the editor at EDITOR_PATH. A typo in the constant is invisible to the
    // build and to the manifest alike: the tab simply opens on a blank page.
    expect(existsSync(`dist/${EDITOR_PATH}`), `dist/${EDITOR_PATH} is missing`).toBe(true)
    expect(existsSync('dist/editor/main.js')).toBe(true)
  })

  it('has the editor page load its script as a module', async () => {
    const html = readFileSync(`dist/${EDITOR_PATH}`, 'utf8')
    const editor = await optionsFor('editor/main')

    // Preact is a static import in the bundle: a classic script would not load this file.
    expect(editor.format).toBe('esm')
    expect(html).toMatch(/<script\s+type="module"\s+src="main\.js"/)
  })

  it('builds the snapshot worker as a classic script', async () => {
    // The bridge starts it with new Worker(url) and no { type: 'module' }.
    const worker = await optionsFor('bridge/snapshot-worker')
    expect(worker.format).toBe('iife')
    expect(existsSync('dist/bridge/snapshot-worker.js')).toBe(true)
  })

  it('builds the history worker as a classic script', async () => {
    // The recording frame starts it the same way the bridge starts the snapshot worker: with
    // new Worker(url) and no { type: 'module' }. And it is the only writer the history has —
    // without an entry point of its own the file never reaches dist, the worker fails to load,
    // and the frame keeps every batch in memory with nothing to say about it.
    const worker = await optionsFor('bridge/history-worker')
    expect(worker.format).toBe('iife')
    expect(existsSync('dist/bridge/history-worker.js')).toBe(true)
  })

  it('builds the waveform worker as a classic script', async () => {
    const worker = await optionsFor('editor/waveform-worker')
    expect(worker.format).toBe('iife')
    expect(existsSync('dist/editor/waveform-worker.js')).toBe(true)
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

      expect(code, `${rel}: нет директивы и обёртки IIFE в начале`).toMatch(IIFE_WRAPPER_START)
      expect(code.trimEnd(), `${rel}: обёртка IIFE не закрыта`).toMatch(/\}\)\(\);$/)
    }
  })

  it('service worker собран в той форме, в какой его грузит манифест', async () => {
    const background = manifest().background
    const sw = await optionsFor('sw/service-worker')
    const code = readFileSync(`dist/${background.service_worker}`, 'utf8')

    // MV3: с "type": "module" воркер грузится как ES-модуль, без него — классическим скриптом.
    const asModule = background.type === 'module'
    expect(
      sw.format,
      `манифест грузит воркер как ${asModule ? 'модуль' : 'классический скрипт'}, сборка — иначе`,
    ).toBe(asModule ? 'esm' : 'iife')

    // Обёртка IIFE у модуля означает, что бандл на деле собран классическим скриптом. Сегодня
    // это сходит с рук, но первый top-level await в воркере пропадёт молча.
    expect(
      IIFE_WRAPPER_START.test(code),
      asModule
        ? 'воркер объявлен модулем, а собран обёрткой IIFE'
        : 'воркер объявлен классическим скриптом, а собран модулем',
    ).toBe(!asModule)
  })

  it('в dist лежат ровно скрипты собираемых точек входа, без лишних', async () => {
    const expected = await shippedScripts()

    expect(expected.length, 'сборка не объявила ни одной точки входа').toBeGreaterThan(4)
    expect(distScripts(), 'в dist есть .js, которого нет ни в одной точке входа').toEqual(expected)
  })

  it('сборка выметает dist: артефакт прошлой сборки не уезжает в поставку', async () => {
    // Точка входа, которую «переименовали»: файл остался с прошлой сборки.
    const stale = 'dist/page/renamed-entry.js'
    writeFileSync(stale, 'globalThis.__tailcut_stale = true\n')

    execFileSync('npm', ['run', 'build'], { stdio: 'pipe' })

    expect(existsSync(stale), `${stale} пережил сборку и уедет в поставку`).toBe(false)
    expect(distScripts()).toEqual(await shippedScripts())
  })

  it('в поставку уходит минифицированная сборка, в разработку — читаемая', async () => {
    for (const o of await buildOptions(false)) {
      expect(o.minify, `${Object.keys(o.entryPoints)}: поставка не минифицируется`).toBe(true)
    }
    for (const o of await buildOptions(true)) {
      expect(o.minify, `${Object.keys(o.entryPoints)}: сборка для разработки минифицируется`).toBe(
        false,
      )
    }

    // То же самое видно на артефакте: в неминифицированном выводе esbuild остаются отступы
    // и комментарии-заголовки исходных файлов.
    const popup = readFileSync('dist/popup/popup.js', 'utf8')
    expect(popup.length, 'бандл попапа пуст — проверять нечего').toBeGreaterThan(1000)
    expect(popup, 'в поставке остались отступы: бандл не минифицирован').not.toMatch(/\n[ \t]+\S/)
    expect(popup, 'в поставке остались комментарии esbuild: бандл не минифицирован').not.toMatch(
      /^\/\/ /m,
    )
  })

  it('бандлер целится ровно в ту версию Chrome, ниже которой расширение не ставится', async () => {
    const minimum = manifest().minimum_chrome_version
    expect(minimum, 'манифест не объявляет минимальную версию Chrome').toMatch(/^\d+$/)

    // Цель выше объявленной — синтаксис, который старый Chrome не разберёт; ниже — расширение
    // тащит лишние преобразования ради версий, куда его всё равно не поставят.
    for (const dev of [false, true]) {
      for (const o of await buildOptions(dev)) {
        expect(
          o.target,
          `${Object.keys(o.entryPoints)}: цель сборки разошлась с minimum_chrome_version`,
        ).toBe(`chrome${minimum}`)
      }
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

  it('каждый content-скрипт объявлен ровно один раз и ровно в своём мире', () => {
    const declared: ContentScript[] = manifest().content_scripts

    // Пары «файл → мир» собираются из всех объявлений разом, а не поиском первого совпадения
    // и не по индексу: второе объявление того же файла в чужом мире прячется за первым, а
    // Chrome исполнит его дважды — второй раз не в той роли.
    const injected = declared.flatMap((c) => c.js.map((js) => `${js} → ${c.world}`)).sort()
    const expected = Object.entries(CONTENT_SCRIPT_WORLDS)
      .map(([js, world]) => `${js} → ${world}`)
      .sort()

    expect(
      injected,
      'состав content-скриптов разошёлся с ролями: лишний, потерянный или не в своём мире',
    ).toEqual(expected)
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

  it('адрес моста из протокола объявлен в манифесте и лежит в поставке', () => {
    // Content script вставляет фрейм по BRIDGE_PATH. Опечатка в самой константе не видна
    // ни сборке, ни манифесту: фрейм просто не грузится, и захват молча выключается.
    // Проверка сверяет константу с внешним миром, а не с собой же.
    expect(
      manifest().web_accessible_resources[0].resources,
      `${BRIDGE_PATH} не объявлен доступным ресурсом — Chrome такой фрейм не отдаст странице`,
    ).toContain(BRIDGE_PATH)
    expect(existsSync(`dist/${BRIDGE_PATH}`), `dist/${BRIDGE_PATH} отсутствует`).toBe(true)
  })

  it('манифест объявлен третьей версией — Chrome другую не загрузит', () => {
    // MV2 в Chrome отключён, а поле world у content-скрипта существует только в MV3:
    // с любым другим числом манифест ещё и внутренне противоречив.
    expect(manifest().manifest_version).toBe(3)
  })

  it('под каждый chrome-API, который зовёт код, в манифесте есть разрешение', () => {
    const used = chromeApisUsedInSrc()
    const declared: string[] = manifest().permissions

    // Проверять нечего, если сканер исходников ничего не нашёл.
    expect(used, 'chrome.* в исходниках не найден — сканер сломан').toContain('runtime')

    for (const namespace of used) {
      if (!GATED_APIS.has(namespace)) continue
      expect(
        declared,
        `код зовёт chrome.${namespace}, но разрешения "${namespace}" в манифесте нет`,
      ).toContain(namespace)
    }
  })

  it('манифест объявляет ровно те разрешения, на которых держатся способности расширения', () => {
    const declared: string[] = manifest().permissions

    for (const [permission, capability] of Object.entries(REQUIRED_PERMISSIONS)) {
      expect(declared, `нет разрешения "${permission}": ${capability}`).toContain(permission)
    }

    // И ничего сверх: лишнее разрешение — лишний экран согласия при установке.
    expect([...declared].sort(), 'в манифесте есть неоправданное разрешение').toEqual(
      Object.keys(REQUIRED_PERMISSIONS).sort(),
    )
  })

  it('расширению открыты все сайты: дозапрос сегментов ходит на чужие origin', () => {
    // matches у content-скрипта права на межсайтовый fetch не даёт — их даёт только
    // host_permissions, и без него дозапрос умирает в рантайме.
    expect(manifest().host_permissions).toEqual(['<all_urls>'])
  })

  it('у кнопки на панели есть подпись', () => {
    // default_title — то, что Chrome показывает подсказкой над кнопкой расширения. Пустая
    // строка оставляет кнопку без подписи: в ряду иконок расширение не опознать.
    const title = manifest().action.default_title

    expect(typeof title, 'default_title не объявлен строкой').toBe('string')
    expect(title.trim(), 'подпись кнопки пуста').not.toBe('')
  })

  it('имя расширения совпадает с именем пакета', () => {
    const name = packageJson().name

    expect(typeof name, 'имя пакета не строка').toBe('string')
    expect(name.trim(), 'имя пакета пусто').not.toBe('')
    expect(manifest().name, 'манифест и пакет разъехались по имени').toBe(name)
  })

  it('версия расширения совпадает с версией пакета', () => {
    const version = packageJson().version

    expect(version, 'версия пакета не похожа на версию').toMatch(/^\d+(\.\d+){1,3}$/)
    expect(manifest().version, 'манифест и пакет разъехались по версии').toBe(version)
  })

  it('описание совпадает с описанием пакета и не пустое', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

    expect(typeof pkg.description).toBe('string')
    expect(pkg.description.trim().length).toBeGreaterThan(0)
    expect(manifest().description).toBe(pkg.description)
  })
})
