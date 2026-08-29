import { describe, it, expect } from 'vitest'
import {
  HISTORY_DIR,
  PIECE_SUFFIX,
  newWriterId,
  pieceName,
  piecePath,
  sessionDir,
} from '../../src/shared/history-files'

/**
 * The names of the pieces, which are load-bearing in two ways and silent in both.
 *
 * The order the pieces are read back in is the order their names sort in — the index walks a
 * directory listing, and a listing comes back sorted as strings. And two tabs on the same video
 * merge into one session (§6.1) and write into one directory, so the name has to say who wrote
 * a piece as well as when: a counter apiece and no writer in the name would have the second tab
 * overwriting the first tab's material with no error anywhere.
 */
describe('history file names', () => {
  it('keeps every session in a directory of its own under the history', () => {
    expect(sessionDir('s-1')).toBe(`${HISTORY_DIR}/s-1`)
    expect(piecePath('s-1', 'aaaa-000003.tcm')).toBe(`${HISTORY_DIR}/s-1/aaaa-000003.tcm`)
  })

  it('sorts the pieces of one writer by string in the order they were written', () => {
    const written = [0, 1, 2, 9, 10, 11, 100, 1000]
    const names = written.map((seq) => pieceName('aaaa', seq))

    // Sorted as strings — which is how a directory listing comes back, and the only order the
    // reader ever sees. Without the padding "…-10" sorts before "…-2" and the material of a
    // session comes back shuffled.
    expect([...names].sort()).toEqual(names)
    expect(names.at(-1)).toBe(`aaaa-001000${PIECE_SUFFIX}`)
  })

  it('tells two writers of one session apart', () => {
    expect(pieceName('aaaa', 0)).not.toBe(pieceName('bbbb', 0))
    expect(piecePath('s-1', pieceName('aaaa', 0))).not.toBe(
      piecePath('s-1', pieceName('bbbb', 0)),
    )
  })

  it('mints a writer identity that is short, hexadecimal and not the same twice', () => {
    const minted = Array.from({ length: 50 }, () => newWriterId())

    for (const id of minted) expect(id).toMatch(/^[0-9a-f]{8}$/)
    expect(new Set(minted).size, 'two writers of one session were given one name').toBe(
      minted.length,
    )
  })
})
