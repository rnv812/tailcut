import { expect, test } from '@playwright/test'
import { launchWithExtension, openExtensionPage } from './helpers'

test('requires explicit responsible-use agreement before exposing extension actions', async () => {
  const { context, extensionId } = await launchWithExtension({ acceptTerms: false })

  try {
    const popup = await openExtensionPage(context, extensionId, 'popup/popup.html')
    await expect(popup.getByTestId('legal-consent')).toBeVisible()
    await expect(popup.getByTestId('legal-continue')).toBeDisabled()
    await expect(popup.getByTestId('recordings')).toHaveCount(0)

    const bottomSpace = await popup.getByTestId('legal-consent').evaluate((card) => {
      const cardBox = card.getBoundingClientRect()
      const bodyBox = document.body.getBoundingClientRect()
      return bodyBox.bottom - cardBox.bottom
    })
    expect(bottomSpace, 'the first-run card touches the bottom of the popup').toBeGreaterThanOrEqual(12)

    await popup.getByTestId('legal-agree').check()
    await popup.getByTestId('legal-continue').click()

    await expect(popup.getByTestId('legal-footer')).toBeVisible()
    await expect(popup.getByTestId('legal-consent')).toHaveCount(0)
    await expect(popup.getByTestId('support-link')).toHaveAttribute(
      'href',
      'https://donatty.com/rnv812',
    )
  } finally {
    await context.close()
  }
})

test('the ordinary launch helper completes first-run consent before returning', async () => {
  const { context, extensionId } = await launchWithExtension()

  try {
    const popup = await openExtensionPage(context, extensionId, 'popup/popup.html')
    await expect(popup.getByTestId('legal-consent')).toHaveCount(0)
    await expect(popup.getByTestId('legal-footer')).toBeVisible()
  } finally {
    await context.close()
  }
})
