import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = (name: string): string => readFileSync(`.github/workflows/${name}.yml`, 'utf8')

const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'
const SETUP_NODE = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'
const UPLOAD_ARTIFACT = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'

const expectVerificationGate = (source: string): void => {
  for (const command of [
    'npm ci',
    'npm run typecheck',
    'npm test',
    'npm run build',
    'npx playwright install --with-deps chromium',
    'npm run e2e:fast',
  ]) {
    expect(source, command).toContain(`run: ${command}`)
  }
}

describe('GitHub Actions workflows', () => {
  it('verifies every master push and pull request before retaining the built extension', () => {
    const source = workflow('ci')

    expect(source).toMatch(/push:\n\s+branches: \[master\]/)
    expect(source).toMatch(/pull_request:\n\s+branches: \[master\]/)
    expect(source).toMatch(/permissions:\n\s+contents: read/)
    expect(source).toContain(CHECKOUT)
    expect(source).toContain(SETUP_NODE)
    expect(source).toContain(UPLOAD_ARTIFACT)
    expect(source).toContain('persist-credentials: false')
    expect(source).toMatch(/name: tailcut-extension-\$\{\{ github\.sha \}\}/)
    expect(source).toMatch(/path: dist\//)
    expectVerificationGate(source)
  })

  it('publishes a version-matched installable archive only after the same gate', () => {
    const source = workflow('release')

    expect(source).toMatch(/tags:\n\s+- 'v\*'/)
    expect(source).toMatch(/permissions:\n\s+contents: write/)
    expect(source).toContain(CHECKOUT)
    expect(source).toContain(SETUP_NODE)
    expect(source).toContain('fetch-depth: 0')
    expect(source).toContain('persist-credentials: false')
    expect(source).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/master')
    expect(source).toContain('node tools/package-release.mjs "$GITHUB_REF_NAME"')
    expect(source).toContain('gh release create "$GITHUB_REF_NAME"')
    expect(source).toContain('--verify-tag')
    expect(source).toContain('release/*.zip')
    expect(source).toContain('release/*.sha256')
    expectVerificationGate(source)
  })
})
