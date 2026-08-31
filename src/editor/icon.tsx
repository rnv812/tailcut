export type IconName =
  | 'plus'
  | 'split'
  | 'marker'
  | 'trash'
  | 'undo'
  | 'redo'
  | 'zoom-out'
  | 'fit-selection'
  | 'fit-all'
  | 'zoom-in'
  | 'snap'
  | 'help'
  | 'recording-start'
  | 'recording-end'
  | 'range-start'
  | 'range-end'
  | 'previous-marker'
  | 'next-marker'
  | 'previous-frame'
  | 'next-frame'
  | 'play'
  | 'pause'
  | 'volume'
  | 'muted'

/** Small line icons inherit the button color and never carry the accessible name themselves. */
export function Icon({ name }: { name: IconName }) {
  const drawing = (() => {
    switch (name) {
      case 'plus':
        return <><path d="M12 5v14M5 12h14" /><rect x="3" y="3" width="18" height="18" rx="3" /></>
      case 'split':
        return <><circle cx="6" cy="7" r="3" /><circle cx="6" cy="17" r="3" /><path d="m8.5 8.5 11 7M8.5 15.5l11-7" /></>
      case 'marker':
        return <path d="m12 3 6 6-6 12L6 9l6-6Z" />
      case 'trash':
        return <><path d="M4 7h16M9 3h6l1 4M7 7l1 14h8l1-14M10 11v6M14 11v6" /></>
      case 'undo':
        return <path d="m9 7-5 5 5 5M5 12h8a6 6 0 0 1 6 6" />
      case 'redo':
        return <path d="m15 7 5 5-5 5m4-5h-8a6 6 0 0 0-6 6" />
      case 'zoom-out':
        return <><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21M7.5 10.5h6" /></>
      case 'zoom-in':
        return <><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21M7.5 10.5h6M10.5 7.5v6" /></>
      case 'fit-selection':
        return <><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /><rect x="8" y="8" width="8" height="8" rx="1" /></>
      case 'fit-all':
        return <><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /><path d="M8 12h8" /></>
      case 'snap':
        return <path d="M5 4v9a7 7 0 0 0 14 0V4h-5v9a2 2 0 0 1-4 0V4H5Z" />
      case 'help':
        return <><circle cx="12" cy="12" r="9" /><path d="M9.8 9a2.4 2.4 0 1 1 3.3 2.2c-.8.4-1.1.9-1.1 1.8M12 17h.01" /></>
      case 'recording-start':
        return <><path d="M5 5v14M19 6l-8 6 8 6V6Z" /></>
      case 'recording-end':
        return <><path d="M19 5v14M5 6l8 6-8 6V6Z" /></>
      case 'range-start':
        return <><path d="M7 5v14M18 7l-7 5 7 5V7Z" /></>
      case 'range-end':
        return <><path d="M17 5v14M6 7l7 5-7 5V7Z" /></>
      case 'previous-marker':
        return <><path d="m8 12 4-4v8l-4-4ZM16 8l4 4-4 4-4-4 4-4Z" /></>
      case 'next-marker':
        return <><path d="m16 12-4-4v8l4-4ZM8 8l4 4-4 4-4-4 4-4Z" /></>
      case 'previous-frame':
        return <path d="m16 7-7 5 7 5V7Z" />
      case 'next-frame':
        return <path d="m8 7 7 5-7 5V7Z" />
      case 'play':
        return <path d="m8 5 11 7-11 7V5Z" />
      case 'pause':
        return <><path d="M8 6v12M16 6v12" /></>
      case 'volume':
        return <><path d="M5 10v4h4l5 4V6L9 10H5Z" /><path d="M17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" /></>
      case 'muted':
        return <><path d="M5 10v4h4l5 4V6L9 10H5Z" /><path d="m17 10 4 4m0-4-4 4" /></>
    }
  })()

  return (
    <svg class="tc-icon" data-icon={name} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        {drawing}
      </g>
    </svg>
  )
}
