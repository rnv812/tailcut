// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { mediaTitleOf } from '../../src/page/media-title'

function video(id: string): HTMLVideoElement {
  return document.querySelector<HTMLVideoElement>(`#${id}`)!
}

describe('mediaTitleOf', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('keeps the captions of two feed cards with one page title apart', () => {
    document.title = 'TikTok'
    document.body.innerHTML = `
      <article>
        <button type="button">Like 12</button>
        <div><video id="first"></video></div>
        <p> First clip\n by Alice </p>
      </article>
      <article>
        <button type="button">Share 7</button>
        <div><video id="second"></video></div>
        <p>Second clip by Bob</p>
      </article>
    `

    expect(mediaTitleOf(video('first'))).toBe('First clip by Alice')
    expect(mediaTitleOf(video('second'))).toBe('Second clip by Bob')
  })

  it('prefers the media element accessible name over its card and fallback', () => {
    document.body.innerHTML = `
      <article>
        <span id="author">Alice</span>
        <span id="caption"> A labelled\n clip </span>
        <video id="labelled" aria-labelledby="author caption"></video>
        <p>Card caption</p>
      </article>
    `

    expect(mediaTitleOf(video('labelled'), 'Media Session title')).toBe('Alice A labelled clip')
  })

  it('uses structured caption metadata before generic card prose', () => {
    document.body.innerHTML = `
      <article itemscope itemtype="https://schema.org/VideoObject">
        <video id="structured"></video>
        <p>Generic prose</p>
        <div><span itemprop="caption">Structured caption</span></div>
      </article>
    `

    expect(mediaTitleOf(video('structured'))).toBe('Structured caption')
  })

  it('does not inspect more than 64 descendants of a card', () => {
    const card = document.createElement('article')
    const bounded = document.createElement('video')
    card.append(bounded)
    for (let index = 0; index < 64; index++) card.append(document.createElement('span'))
    const late = document.createElement('p')
    late.textContent = 'Too late'
    card.append(late)
    document.body.append(card)

    expect(mediaTitleOf(bounded, 'Only bounded fallback')).toBe('Only bounded fallback')
  })
})
