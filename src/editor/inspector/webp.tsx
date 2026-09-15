import { useEffect, useState } from 'preact/hooks'
import type { Clip } from '../../core/edit/clip'
import type { EditContext } from '../../core/edit/context'
import type { SessionAction } from '../../core/edit/session'
import { DEFAULT_WEBP, WEBP_FPS_LIMIT, WEBP_SIDE_LIMIT, webpGeometry, type WebpOptions } from '../../core/webp/timing'

function NumberField({ label, id, value, max, step = 1, onCommit }: {
  label: string; id: string; value: number; max: number; step?: number | 'any'; onCommit: (value: number) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  return <label class="option tc-clip-select">
    <span class="label">{label}</span>
    <input type="number" data-testid={id} value={text} min={1} max={max} step={step}
      onInput={event => setText(event.currentTarget.value)}
      onBlur={event => {
        if (text !== '' && event.currentTarget.validity.valid) onCommit(Number(text))
        else setText(String(value))
      }}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
  </label>
}

export function WebpControls({ clip, ctx, dispatch }: {
  clip: Clip; ctx: EditContext; dispatch: (action: SessionAction) => void
}) {
  const options = clip.webp ?? DEFAULT_WEBP
  const picture = clip.crop ?? ctx.frameSize
  const geometry = webpGeometry(picture, ctx.fps, options)
  const change = (patch: Partial<WebpOptions>) =>
    dispatch({ type: 'setWebp', id: clip.id, options: { ...options, ...patch } })
  return <div data-testid={`webp-options-${clip.id}`}>
    <div class="tc-clip-options">
      <NumberField label="Longest side (px)" id={`webp-size-${clip.id}`} value={options.maxSide}
        max={WEBP_SIDE_LIMIT} onCommit={maxSide => change({ maxSide })} />
      <NumberField label="Frames per second" id={`webp-fps-${clip.id}`} value={geometry.framerate}
        max={Math.min(WEBP_FPS_LIMIT, ctx.fps || WEBP_FPS_LIMIT)} step="any"
        onCommit={fps => change({ fps })} />
    </div>
    <button type="button" data-testid={`webp-original-${clip.id}`}
      onClick={() => change({ maxSide: Math.min(WEBP_SIDE_LIMIT, Math.max(picture.width, picture.height)) })}>
      Original size
    </button>
    <p class="muted" data-testid={`webp-output-${clip.id}`}>
      {geometry.width} × {geometry.height} · {Number(geometry.framerate.toFixed(3))} fps. Proportions preserved.
    </p>
  </div>
}
