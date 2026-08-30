import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const theme = (): string => readFileSync('src/shared/theme.css', 'utf8')

describe('the runtime brand theme', () => {
  it('uses the palette delivered with the tailcut artwork', () => {
    const css = theme()

    // These values come from assets/tailcut/README.txt, independently of this stylesheet. A
    // replacement blue accent or grey logo would otherwise remain a valid piece of CSS and no
    // functional test could say that the product had stopped looking like its own artwork.
    expect(css).toContain('--tc-graphite: #17181f')
    expect(css).toContain('--tc-accent: #b7f03f')
    expect(css).toContain('--tc-paper: #f6f5f8')
  })

  it('gives keyboard focus a visible brand-coloured ring', () => {
    const css = theme()

    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--tc-accent\)/s)
    expect(css).toMatch(/:focus:not\(:focus-visible\)\s*\{[^}]*outline:\s*none/s)
  })
})
