import { useState } from 'preact/hooks'

export const PRIVACY_URL = 'https://github.com/rnv812/tailcut/blob/master/PRIVACY.md'
export const TERMS_URL = 'https://github.com/rnv812/tailcut/blob/master/TERMS.md'
export const SUPPORT_URL = 'https://donatty.com/rnv812'

const ExternalLink = (props: {
  href: string
  children: preact.ComponentChildren
  testId?: string
}) => (
  <a href={props.href} target="_blank" rel="noreferrer" data-testid={props.testId}>
    {props.children}
  </a>
)

export function LegalConsent(props: { onAccept: () => void | Promise<void> }) {
  const [agreed, setAgreed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  return (
    <section class="legal-consent" data-testid="legal-consent">
      <h2>Use tailcut responsibly</h2>
      <p>
        Save only media you own, are authorized to copy, or may copy under applicable law.
        You are responsible for copyright, privacy, website terms, and local law.
      </p>
      <p>
        tailcut does not bypass DRM and does not grant permission to copy media. Processing stays
        on this device as described in the <ExternalLink href={PRIVACY_URL}>Privacy Policy</ExternalLink>.
      </p>
      <label class="legal-agreement">
        <input
          type="checkbox"
          data-testid="legal-agree"
          checked={agreed}
          onChange={(event) => setAgreed((event.target as HTMLInputElement).checked)}
        />
        <span>
          I have read and agree to the <ExternalLink href={TERMS_URL}>Terms of Use</ExternalLink> and{' '}
          <ExternalLink href={PRIVACY_URL}>Privacy Policy</ExternalLink>.
        </span>
      </label>
      <button
        class="legal-continue"
        data-testid="legal-continue"
        disabled={!agreed || saving}
        onClick={async () => {
          setSaving(true)
          setFailed(false)
          try {
            await props.onAccept()
          } catch {
            setSaving(false)
            setFailed(true)
          }
        }}
      >
        {saving ? 'Saving…' : 'Continue'}
      </button>
      {failed && (
        <p class="legal-error" data-testid="legal-error" role="alert">
          Could not save your agreement. Try again.
        </p>
      )}
    </section>
  )
}

export function LegalFooter() {
  return (
    <footer class="legal-footer" data-testid="legal-footer">
      <span>
        Only save media you own or are allowed to use.{' '}
        <span id="donation-note">Donations are voluntary and unlock no features or benefits.</span>
      </span>
      <nav aria-label="Legal and support">
        <ExternalLink href={PRIVACY_URL}>Privacy</ExternalLink>
        <ExternalLink href={TERMS_URL}>Terms</ExternalLink>
        <a
          class="legal-donate"
          href={SUPPORT_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="support-link"
          aria-describedby="donation-note"
          title="Donation is voluntary and provides no features or benefits"
        >
          Donate
        </a>
      </nav>
    </footer>
  )
}
