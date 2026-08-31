import { useState } from 'preact/hooks'

export const PRIVACY_URL = 'https://github.com/rnv812/tailcut/blob/master/PRIVACY.md'
export const TERMS_URL = 'https://github.com/rnv812/tailcut/blob/master/TERMS.md'
export const SUPPORT_URL = 'https://donatty.com/rnv812'

const SUPPORT_TITLE =
  'tailcut is free and open source. If it saves you time, support the author.'

const ExternalLink = (props: {
  href: string
  children: preact.ComponentChildren
  testId?: string
}) => (
  <a href={props.href} target="_blank" rel="noreferrer" data-testid={props.testId}>
    {props.children}
  </a>
)

export function SupportLink() {
  return (
    <a
      class="tc-support-link"
      href={SUPPORT_URL}
      target="_blank"
      rel="noreferrer"
      data-testid="support-link"
      title={SUPPORT_TITLE}
      aria-label="Support the author"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />
      </svg>
      <span>Support the author</span>
    </a>
  )
}

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
      <span>Use only media you have permission to save.</span>
      <nav aria-label="Legal">
        <ExternalLink href={PRIVACY_URL}>Privacy</ExternalLink>
        <ExternalLink href={TERMS_URL}>Terms</ExternalLink>
      </nav>
    </footer>
  )
}
