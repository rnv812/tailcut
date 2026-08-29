import { describe, it, expect } from 'vitest'
import {
  HISTORY_DIR,
  PIECE_SUFFIX,
  newWriterId,
  pieceName,
  piecePath,
  sessionDir,
} from '../../src/shared/history-files'
import { SNAPSHOT_DIR, snapshotFileName, snapshotPath } from '../../src/shared/protocol'

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

/**
 * The history is a neighbour of the snapshots and never a lodger.
 *
 * This is the Global Constraint of the stage — "the history is the directory beside the snapshots,
 * another writer, another life span" — and until now nothing in the repository said so. Everything
 * that mentions these two constants compares them with themselves: the unit set above builds a
 * path out of `HISTORY_DIR` and expects a path built out of `HISTORY_DIR`, and the browser set
 * takes both sides from the same module on purpose. Given `HISTORY_DIR = 'snapshots'` and
 * `PIECE_SUFFIX = '.tcs'` — the directory and the extension of the other writer — every test in the
 * repository stayed green. These two are what says otherwise.
 *
 * Why the two are load-bearing, in the order the code depends on them. The directory is the only
 * thing that separates two life spans: a snapshot is one temporary file under one edit and is
 * thrown away after it, a session of the history is kept for days and swept by age, size and
 * ceiling (Task 5). The sweeper walks storage and decides what to drop by the directory a file is
 * in and by nothing else, so a history inside `snapshots/` would have one of them evicting the
 * other's material with no error anywhere. The extension is what tells the two kinds of file apart
 * once opened: `.tcs` is a sealed snapshot — the whole of a session with an index and a footer
 * over it — and `.tcm` is one batch of raw material with no index at all. The editor is about to
 * grow a second door (Task 4) and open both kinds by name.
 */
describe('history storage against snapshot storage', () => {
  it('puts the history in a directory of its own, beside the snapshots and not inside them', () => {
    const swept = 'the history moved into the directory the snapshots are swept from'
    expect(HISTORY_DIR, swept).not.toBe(SNAPSHOT_DIR)
    // One segment apiece: both sit at the root of OPFS, which is what makes them neighbours.
    expect(HISTORY_DIR.split('/')).toHaveLength(1)
    expect(HISTORY_DIR).not.toBe('')
    expect(sessionDir('s-1').startsWith(`${SNAPSHOT_DIR}/`)).toBe(false)
  })

  it('gives a piece a name no snapshot can wear', () => {
    expect(pieceName('aaaa', 0).endsWith(PIECE_SUFFIX)).toBe(true)
    expect(
      snapshotFileName('11111111-2222-3333-4444-555555555555').endsWith(PIECE_SUFFIX),
      'a snapshot and a piece of material now share an extension, and they are not the same file',
    ).toBe(false)
    expect(piecePath('s-1', pieceName('aaaa', 0))).not.toBe(
      snapshotPath('11111111-2222-3333-4444-555555555555'),
    )
  })
})
