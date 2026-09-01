const MAX_LABEL_IDS = 4
const MAX_ANCESTORS = 6
const MAX_DESCENDANTS = 64
const MAX_DEPTH = 4
const MAX_TITLE_CODE_POINTS = 240

const STRUCTURED_ITEM_PROPS = new Set(['name', 'headline', 'caption', 'description'])

/** One line fit for the popup and a file name, with a hard bound on untrusted page text. */
function titleText(text: string | null | undefined): string {
  const compact = (text ?? '').replace(/\s+/gu, ' ').trim()
  return Array.from(compact).slice(0, MAX_TITLE_CODE_POINTS).join('')
}

function attribute(element: Element, name: string): string | null {
  try {
    return element.getAttribute?.(name) ?? null
  } catch {
    return null
  }
}

function tokens(element: Element, name: string): string[] {
  return (attribute(element, name) ?? '').split(/\s+/u).filter(Boolean)
}

function isMediaContainer(element: Element): boolean {
  const tag = element.localName.toLowerCase()
  if (tag === 'article' || tag === 'figure' || attribute(element, 'role') === 'article') {
    return true
  }

  return tokens(element, 'itemtype').some((token) =>
    /(?:^|[/#])videoobject$/iu.test(token),
  )
}

function isStructuredCaption(element: Element): boolean {
  if (element.localName.toLowerCase() === 'figcaption') return true
  return tokens(element, 'itemprop').some((token) =>
    STRUCTURED_ITEM_PROPS.has(token.toLowerCase()),
  )
}

function isHeading(element: Element): boolean {
  return /^h[1-6]$/u.test(element.localName.toLowerCase()) || attribute(element, 'role') === 'heading'
}

/**
 * Finds a caption without asking the whole card for text. Structured metadata wins even when a
 * paragraph or heading occurs earlier in tree order.
 */
function captionWithin(container: Element): string {
  const queue = Array.from(container.children, (element) => ({ element, depth: 1 }))
  let visited = 0
  let paragraph = ''
  let heading = ''

  while (queue.length > 0 && visited < MAX_DESCENDANTS) {
    const next = queue.shift()!
    visited++

    const text = titleText(next.element.textContent)
    if (text) {
      if (isStructuredCaption(next.element)) return text
      if (!paragraph && next.element.localName.toLowerCase() === 'p') paragraph = text
      if (!heading && isHeading(next.element)) heading = text
    }

    if (next.depth >= MAX_DEPTH) continue
    for (const child of Array.from(next.element.children)) {
      queue.push({ element: child, depth: next.depth + 1 })
    }
  }

  return paragraph || heading
}

function labelledTitle(video: HTMLMediaElement): string {
  const ids = tokens(video, 'aria-labelledby').slice(0, MAX_LABEL_IDS)
  if (ids.length === 0) return ''

  const root = video.getRootNode?.() as Document | ShadowRoot | undefined
  return titleText(ids.map((id) => root?.getElementById(id)?.textContent ?? '').join(' '))
}

/**
 * Derives a title scoped to one video. The optional fallback is supplied by the caller only when
 * it knows that a page-wide title, such as Media Session metadata, belongs to this one player.
 */
export function mediaTitleOf(video: HTMLMediaElement, fallbackTitle = ''): string {
  const labelled = labelledTitle(video)
  if (labelled) return labelled

  const own = titleText(video.ariaLabel || attribute(video, 'aria-label') || video.title)
  if (own) return own

  let ancestor = video.parentElement
  for (let distance = 0; ancestor && distance < MAX_ANCESTORS; distance++) {
    if (isMediaContainer(ancestor)) {
      const containerTitle = titleText(
        attribute(ancestor, 'aria-label') || attribute(ancestor, 'title'),
      )
      return containerTitle || captionWithin(ancestor) || titleText(fallbackTitle)
    }
    ancestor = ancestor.parentElement
  }

  return titleText(fallbackTitle)
}
