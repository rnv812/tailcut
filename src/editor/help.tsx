export interface KeyRow {
  keys: string
  does: string
}

/**
 * The keyboard, written out. Shown by `?`.
 *
 * It is a constant and not a paragraph in a README because a test walks it: every press the
 * editor answers to has to appear here, and every line here has to be answered by something.
 */
export const KEY_HELP: readonly KeyRow[] = [
  { keys: 'Space', does: 'Play or pause' },
  { keys: 'J · K · L', does: 'Shuttle back, stop, shuttle forward — 1× 2× 4× 8× 16×' },
  { keys: '← · →', does: 'One frame' },
  { keys: 'Shift ← · Shift →', does: 'One second' },
  { keys: 'Home · End', does: 'Start and end of the recording' },
  { keys: 'I · O', does: 'In and out point — of the selected clip, or of a new one' },
  { keys: 'S', does: 'Split the selected clip at the playhead' },
  { keys: 'M · Shift M', does: 'Drop a marker at the playhead · take that one away' },
  { keys: 'N', does: 'Snapping on and off' },
  { keys: 'Delete · Backspace', does: 'Remove the selected clip' },
  { keys: 'Z · F', does: 'Fit the selected clip · fit the whole recording' },
  { keys: '+ · −', does: 'Zoom around the playhead' },
  { keys: 'Ctrl Z', does: 'Undo' },
  { keys: 'Ctrl Shift Z · Ctrl Y', does: 'Redo' },
  { keys: '?', does: 'This list' },
]

export function HelpSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null

  return (
    <div class="tc-help" data-testid="help" role="dialog" aria-label="Keyboard">
      <div class="tc-help-sheet">
        <h2>Keyboard</h2>
        <table>
          <tbody>
            {KEY_HELP.map((row) => (
              <tr key={row.keys} data-testid="help-row">
                <th>{row.keys}</th>
                <td>{row.does}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" data-testid="help-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
