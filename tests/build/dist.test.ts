import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { BRIDGE_PATH, EDITOR_PATH } from '../../src/shared/protocol'

/**
 * The build has its own timeout, deliberately shorter than the hook timeout, so a hung build
 * becomes a catchable exception instead of timing out the hook.
 */
const BUILD_TIMEOUT_MS = 120_000

const buildFailureText = (cause: unknown): string => {
  const stderr = (cause as { stderr?: { toString(): string } }).stderr?.toString().trim()
  return [String(cause), stderr].filter(Boolean).join('\n')
}

let buildFailure: Error | undefined

beforeAll(() => {
  try {
    // Build from scratch. With a warm dist, the suite would only test rebuilding over an existing
    // tree and would miss a build that cannot start on a clean clone.
    rmSync('dist', { recursive: true, force: true })
    execFileSync('npm', ['run', 'build'], { stdio: 'pipe', timeout: BUILD_TIMEOUT_MS })
  } catch (cause) {
    buildFailure = new Error(`the build failed, so there is nothing to test:\n${buildFailureText(cause)}`)
  }
}, BUILD_TIMEOUT_MS + 30_000)

/**
 * A failed build must fail every test. Throwing directly from beforeAll would mark the entire
 * suite as skipped: no checks run, none fail, and coverage silently drops to zero.
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
 * Build configuration read from build.mjs itself. Importing it only returns the configuration;
 * the script builds only when invoked from the command line. The specifier is computed because
 * build.mjs is untyped, so EntryOptions above defines the contract.
 */
const BUILD_SCRIPT = new URL('../../build.mjs', import.meta.url).href

const buildOptions = async (dev: boolean): Promise<EntryOptions[]> => {
  const script: { buildOptions(dev: boolean): EntryOptions[] } = await import(BUILD_SCRIPT)
  return script.buildOptions(dev)
}

const optionsFor = async (entry: string): Promise<EntryOptions> => {
  const found = (await buildOptions(false)).find((o) => entry in o.entryPoints)
  if (!found) throw new Error(`entry point ${entry} is not built`)
  return found
}

/** Scripts the build must place in dist, one per entry point. */
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
  if (!found) throw new Error(`content script ${js} is not declared in the manifest`)
  return found
}

const distScripts = (): string[] =>
  readdirSync('dist', { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.js'))
    .sort()

// Static import/export … from "…" and side-effect import "…" at the bundle's top level.
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

// A bare specifier is one Chrome cannot resolve without a bundler: not relative, not an absolute
// path, and not a URL with a scheme.
const isBareSpecifier = (spec: string): boolean => !/^(?:\.{1,2}\/|\/|[a-zA-Z][\w+.-]*:)/.test(spec)

// Start of the wrapper esbuild puts around an IIFE bundle.
const IIFE_WRAPPER_START = /^"use strict";\s*\(\s*\(\s*\)\s*=>\s*\{/

/**
 * chrome.* namespaces MV3 exposes only with the matching permission. Without the permissions
 * entry, the namespace is undefined at run time and a call fails.
 */
const GATED_APIS = new Set([
  'alarms', 'bookmarks', 'contextMenus', 'cookies', 'declarativeNetRequest', 'downloads',
  'history', 'idle', 'management', 'notifications', 'offscreen', 'scripting', 'storage',
  'tabCapture', 'topSites', 'webNavigation', 'webRequest',
])

/** chrome.* namespaces used by the extension code. */
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
 * Content-script file to the world where it must run. The world defines its role: MAIN can see
 * and patch the page's MSE, while ISOLATED can see only the extension's own objects.
 */
const CONTENT_SCRIPT_WORLDS: Record<string, string> = {
  'page/main-hook.js': 'MAIN',
  'page/content.js': 'ISOLATED',
}

/**
 * Permission to the capability that depends on it. Removing the capability removes the need for
 * the permission, and without the permissions entry the capability does not exist at run time.
 */
const REQUIRED_PERMISSIONS: Record<string, string> = {
  activeTab: 'the popup can access the tab the user is viewing',
  alarms: 'the badge is recalculated even after the service worker goes to sleep',
  downloads: 'the finished clip is saved as a file, which is the extension\'s purpose',
  scripting: 'the popup and badge enumerate every frame in the tab to query each one',
  storage: 'the session registry and domain rules survive service worker termination',
}

describe('build', () => {
  it('runs extension pages in the incognito profile that recorded their material', () => {
    // A snapshot is written by the bridge inside the source tab and read by a top-level editor
    // page. Chrome's default `spanning` mode cannot put that extension page in an incognito tab,
    // so it opens against the regular profile and sees no snapshot at all.
    expect(manifest().incognito).toBe('split')
  })

  it('puts every file referenced by the manifest in dist', () => {
    const m = manifest()
    const referenced: string[] = [
      m.background.service_worker,
      m.action.default_popup,
      ...m.content_scripts.flatMap((c: { js: string[] }) => c.js),
      ...m.web_accessible_resources.flatMap((w: { resources: string[] }) => w.resources),
      m.options_ui.page,
    ]

    expect(referenced.length).toBeGreaterThan(5)
    for (const rel of referenced) {
      expect(existsSync(`dist/${rel}`), `dist/${rel} is missing`).toBe(true)
    }
  })

  it('includes pages and their scripts in the build', () => {
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

  it('ships the modules a page of the extension imports by address at run time', async () => {
    // All three are imported from a page of the extension by address — `import('/shared/history-db.js')`
    // in the popup and the tests of the index, `import('/shared/settings-store.js')` on the
    // settings page, `import('/sw/sweeper.js')` by the end-to-end run that asks for a repair with
    // no grace — and Chrome resolves that against dist. None is reachable through another entry
    // point in a form Chrome could load: the bridge and the service worker bundle their own copies,
    // and a bundled copy is not a file. Without an entry point apiece the import fails at run time
    // with nothing to say.
    for (const entry of ['shared/history-db', 'shared/settings-store', 'sw/sweeper']) {
      const options = await optionsFor(entry)
      expect(options.format, `${entry}: a page imports it as a module`).toBe('esm')
      expect(existsSync(`dist/${entry}.js`), `dist/${entry}.js is missing`).toBe(true)
    }
  })

  it('builds the waveform worker as a classic script', async () => {
    const worker = await optionsFor('editor/waveform-worker')
    expect(worker.format).toBe('iife')
    expect(existsSync('dist/editor/waveform-worker.js')).toBe(true)
  })

  it('ships the settings page, its script, and the declaration Chrome opens it by', async () => {
    // Nothing of ours links to this page: it is reached through options_ui and through the
    // browser's own menu on the extension. A missing declaration is therefore not a broken link
    // — it is a settings page that does not exist as far as the browser is concerned.
    const declared = manifest().options_ui
    expect(declared?.page, 'the manifest declares no settings page').toBe('options/options.html')
    expect(declared.open_in_tab, 'the settings UI needs a tab, not a popup-sized box').toBe(
      true,
    )

    expect(existsSync(`dist/${declared.page}`), `dist/${declared.page} is missing`).toBe(true)
    expect(existsSync('dist/options/options.js')).toBe(true)

    // Preact is a static import in the bundle: a classic script would not load this file.
    const built = await optionsFor('options/options')
    expect(built.format).toBe('esm')
    expect(readFileSync(`dist/${declared.page}`, 'utf8')).toMatch(
      /<script\s+type="module"\s+src="options\.js"/,
    )
  })

  it('leaves no bare-specifier imports in built scripts', () => {
    const scripts = distScripts()
    expect(scripts).toContain('popup/popup.js')
    expect(scripts).toContain('bridge/bridge.js')

    const bare = scripts.flatMap((rel) =>
      importedSpecifiers(readFileSync(`dist/${rel}`, 'utf8'))
        .filter(isBareSpecifier)
        .map((spec) => `${rel}: import "${spec}"`),
    )

    expect(bare, 'dependencies are not bundled, so Chrome cannot load this file').toEqual([])
  })

  it('builds content scripts as classic scripts rather than modules', () => {
    for (const rel of ['page/main-hook.js', 'page/content.js']) {
      const code = readFileSync(`dist/${rel}`, 'utf8')

      // A classic script with import/export raises a SyntaxError during parsing.
      expect(
        () => new Script(code, { filename: rel }),
        `${rel}: cannot be parsed as a classic script`,
      ).not.toThrow()

      expect(code, `${rel}: no directive and IIFE wrapper at the start`).toMatch(IIFE_WRAPPER_START)
      expect(code.trimEnd(), `${rel}: the IIFE wrapper is not closed`).toMatch(/\}\)\(\);$/)
    }
  })

  it('builds the service worker in the form loaded by the manifest', async () => {
    const background = manifest().background
    const sw = await optionsFor('sw/service-worker')
    const code = readFileSync(`dist/${background.service_worker}`, 'utf8')

    // In MV3, "type": "module" loads the worker as an ES module; without it, as a classic script.
    const asModule = background.type === 'module'
    expect(
      sw.format,
      `the manifest loads the worker as ${asModule ? 'a module' : 'a classic script'}, but the build does not`,
    ).toBe(asModule ? 'esm' : 'iife')

    // An IIFE wrapper on a module means the bundle was actually built as a classic script. This
    // currently works, but the first top-level await in the worker would silently disappear.
    expect(
      IIFE_WRAPPER_START.test(code),
      asModule
        ? 'the worker is declared as a module but built with an IIFE wrapper'
        : 'the worker is declared as a classic script but built as a module',
    ).toBe(!asModule)
  })

  it('puts exactly the built entry-point scripts in dist with no extras', async () => {
    const expected = await shippedScripts()

    expect(expected.length, 'the build declares no entry points').toBeGreaterThan(4)
    expect(distScripts(), 'dist contains a .js file that is not an entry point').toEqual(expected)
  })

  it('cleans dist so an artifact from an earlier build is not shipped', async () => {
    // An entry point that was "renamed": the file remains from the previous build.
    const stale = 'dist/page/renamed-entry.js'
    writeFileSync(stale, 'globalThis.__tailcut_stale = true\n')

    execFileSync('npm', ['run', 'build'], { stdio: 'pipe' })

    expect(existsSync(stale), `${stale} survived the build and will be shipped`).toBe(false)
    expect(distScripts()).toEqual(await shippedScripts())
  })

  it('ships a minified build and keeps development builds readable', async () => {
    for (const o of await buildOptions(false)) {
      expect(o.minify, `${Object.keys(o.entryPoints)}: the release build is not minified`).toBe(true)
    }
    for (const o of await buildOptions(true)) {
      expect(o.minify, `${Object.keys(o.entryPoints)}: the development build is minified`).toBe(
        false,
      )
    }

    // The artifact shows the same thing: unminified esbuild output retains indentation and source
    // file header comments.
    const popup = readFileSync('dist/popup/popup.js', 'utf8')
    expect(popup.length, 'the popup bundle is empty, so there is nothing to test').toBeGreaterThan(1000)
    expect(popup, 'the release contains indentation, so the bundle is not minified').not.toMatch(/\n[ \t]+\S/)
    expect(popup, 'the release contains esbuild comments, so the bundle is not minified').not.toMatch(
      /^\/\/ /m,
    )
  })

  it('targets exactly the oldest Chrome version that can install the extension', async () => {
    const minimum = manifest().minimum_chrome_version
    expect(minimum, 'the manifest does not declare a minimum Chrome version').toMatch(/^\d+$/)

    // A higher target allows syntax old Chrome cannot parse; a lower target adds transformations
    // for versions where the extension cannot be installed anyway.
    for (const dev of [false, true]) {
      for (const o of await buildOptions(dev)) {
        expect(
          o.target,
          `${Object.keys(o.entryPoints)}: build target differs from minimum_chrome_version`,
        ).toBe(`chrome${minimum}`)
      }
    }
  })
})

describe('manifest', () => {
  it('declares the hook in the MAIN world and starts it before page scripts', () => {
    const hook = contentScript('page/main-hook.js')
    expect(hook.world).toBe('MAIN')
    expect(hook.run_at).toBe('document_start')
    expect(hook.all_frames).toBe(true)
  })

  it('runs the watcher in the isolated world', () => {
    const content = contentScript('page/content.js')
    expect(content.world).toBe('ISOLATED')
    expect(content.run_at).toBe('document_start')
    expect(content.all_frames).toBe(true)
  })

  it('declares every content script exactly once and in its own world', () => {
    const declared: ContentScript[] = manifest().content_scripts

    // Collect file-to-world pairs from all declarations at once, not by finding the first match
    // or using an index. A second declaration of the same file in another world hides behind the
    // first, yet Chrome runs it twice, the second time in the wrong role.
    const injected = declared.flatMap((c) => c.js.map((js) => `${js} → ${c.world}`)).sort()
    const expected = Object.entries(CONTENT_SCRIPT_WORLDS)
      .map(([js, world]) => `${js} → ${world}`)
      .sort()

    expect(
      injected,
      'content scripts do not match their roles: one is extra, missing, or in the wrong world',
    ).toEqual(expected)
  })

  it('declares both content scripts for all sites without domain restrictions', () => {
    expect(contentScript('page/main-hook.js').matches).toEqual(['<all_urls>'])
    expect(contentScript('page/content.js').matches).toEqual(['<all_urls>'])
  })

  it('makes the bridge available to every page', () => {
    const war = manifest().web_accessible_resources[0]
    expect(war.resources).toContain('bridge/bridge.html')
    expect(war.matches).toContain('<all_urls>')
  })

  it('declares the protocol bridge path in the manifest and ships it', () => {
    // The content script inserts a frame at BRIDGE_PATH. Neither the build nor the manifest can
    // detect a typo in the constant: the frame simply fails to load and capture silently stops.
    // This check compares the constant with the outside world rather than with itself.
    expect(
      manifest().web_accessible_resources[0].resources,
      `${BRIDGE_PATH} is not declared as an accessible resource, so Chrome will not serve it to the page`,
    ).toContain(BRIDGE_PATH)
    expect(existsSync(`dist/${BRIDGE_PATH}`), `dist/${BRIDGE_PATH} is missing`).toBe(true)
  })

  it('declares manifest version three because Chrome will not load another version', () => {
    // Chrome has disabled MV2, and the content-script world field exists only in MV3, so any
    // other number would also make the manifest internally inconsistent.
    expect(manifest().manifest_version).toBe(3)
  })

  it('has a manifest permission for every chrome API used by the code', () => {
    const used = chromeApisUsedInSrc()
    const declared: string[] = manifest().permissions

    // There is nothing to test if the source scanner finds nothing.
    expect(used, 'chrome.* was not found in the source, so the scanner is broken').toContain('runtime')

    for (const namespace of used) {
      if (!GATED_APIS.has(namespace)) continue
      expect(
        declared,
        `the code calls chrome.${namespace}, but the manifest lacks the "${namespace}" permission`,
      ).toContain(namespace)
    }
  })

  it('declares exactly the permissions required by the extension capabilities', () => {
    const declared: string[] = manifest().permissions

    for (const [permission, capability] of Object.entries(REQUIRED_PERMISSIONS)) {
      expect(declared, `missing "${permission}" permission: ${capability}`).toContain(permission)
    }

    // No extras: an unnecessary permission adds an unnecessary consent prompt during install.
    expect([...declared].sort(), 'the manifest contains an unjustified permission').toEqual(
      Object.keys(REQUIRED_PERMISSIONS).sort(),
    )
  })

  it('allows all sites because segment refetches use other origins', () => {
    // A content script's matches do not permit cross-origin fetches; only host_permissions does,
    // and without it the refetch fails at run time.
    expect(manifest().host_permissions).toEqual(['<all_urls>'])
  })

  it('gives the toolbar button a label', () => {
    // default_title is the tooltip Chrome shows over the extension button. An empty string leaves
    // the button unlabeled, making the extension impossible to identify among a row of icons.
    const title = manifest().action.default_title

    expect(typeof title, 'default_title is not declared as a string').toBe('string')
    expect(title.trim(), 'the button label is empty').not.toBe('')
  })

  it('matches the extension name to the package name', () => {
    const name = packageJson().name

    expect(typeof name, 'the package name is not a string').toBe('string')
    expect(name.trim(), 'the package name is empty').not.toBe('')
    expect(manifest().name, 'the manifest and package names differ').toBe(name)
  })

  it('matches the extension version to the package version', () => {
    const version = packageJson().version

    expect(version, 'the package version does not look like a version').toMatch(/^\d+(\.\d+){1,3}$/)
    expect(manifest().version, 'the manifest and package versions differ').toBe(version)
  })

  it('matches the description to the package description and keeps it nonempty', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

    expect(typeof pkg.description).toBe('string')
    expect(pkg.description.trim().length).toBeGreaterThan(0)
    expect(manifest().description).toBe(pkg.description)
  })
})
