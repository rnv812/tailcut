import type { BrowserContext, Page } from '@playwright/test'
import { describe, expect, it, vi } from 'vitest'
import { acceptFirstRunTerms, closeContextOnFailure } from '../e2e/helpers'

describe('the browser helper consent setup', () => {
  it('waits for the asynchronous legal state before deciding a fresh profile is accepted', async () => {
    const events: string[] = []
    let consentVisible = false

    const footer = {
      waitFor: vi.fn(async () => { events.push('footer') }),
    }
    const agreement = {
      check: vi.fn(async () => { events.push('check') }),
    }
    const proceed = {
      click: vi.fn(async () => { events.push('click') }),
    }
    const settled = {
      waitFor: vi.fn(async () => {
        events.push('settled')
        consentVisible = true
      }),
    }
    const consent = {
      or: vi.fn(() => settled),
      isVisible: vi.fn(async () => {
        events.push('visible')
        return consentVisible
      }),
    }
    const page = {
      getByTestId: vi.fn((testId: string) => ({
        'legal-consent': consent,
        'legal-footer': footer,
        'legal-agree': agreement,
        'legal-continue': proceed,
      })[testId]),
    }

    await acceptFirstRunTerms(page as unknown as Page)

    expect(events).toEqual(['settled', 'visible', 'check', 'click', 'footer'])
  })

  it('closes a launched context when extension setup fails', async () => {
    const failure = new Error('consent page failed')
    const close = vi.fn(async () => undefined)

    await expect(
      closeContextOnFailure(
        { close } as unknown as BrowserContext,
        async () => { throw failure },
      ),
    ).rejects.toBe(failure)

    expect(close).toHaveBeenCalledOnce()
  })

  it('leaves a successfully prepared context open for its caller', async () => {
    const close = vi.fn(async () => undefined)

    await expect(
      closeContextOnFailure(
        { close } as unknown as BrowserContext,
        async () => 'ready',
      ),
    ).resolves.toBe('ready')

    expect(close).not.toHaveBeenCalled()
  })
})
