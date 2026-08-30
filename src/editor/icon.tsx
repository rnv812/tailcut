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
    }
  })()

  return (
    <svg class="tc-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        {drawing}
      </g>
    </svg>
  )
}
