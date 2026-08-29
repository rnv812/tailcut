import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { isQuotaError } from '../../src/bridge/sync-write'

/**
 * The promise the module's header makes, kept by a test rather than by a comment.
 *
 * It was a comment for one stage and it went false in the next: two workers write now, and the
 * header of the snapshot worker still said it was the only one. A second copy of that call is a
 * second chance to hold the exclusive lock a moment too long, and nothing in the program would
 * report it — the sweeper would simply stop being able to evict anything of a live session.
 */
describe('the call to createSyncAccessHandle', () => {
  it('is made in one file of the extension and in no other', () => {
    const sources = readdirSync('src', { recursive: true, encoding: 'utf8' }).filter((rel) =>
      /\.tsx?$/.test(rel),
    )
    expect(sources.length, 'nothing was scanned').toBeGreaterThan(20)

    const callers = sources
      .filter((rel) => /\bcreateSyncAccessHandle\s*\(/.test(readFileSync(`src/${rel}`, 'utf8')))
      .map((rel) => rel.split('\\').join('/'))
      .sort()

    expect(callers).toEqual(['bridge/sync-write.ts'])
  })
})

/**
 * Telling a full disk apart from a defect, which is the whole of what the writer decides on.
 *
 * The two get different answers: a quota refusal costs the batch and wakes the sweeper, anything
 * else is a bug and retrying it would only write the same failure again. A predicate that
 * answered true to everything would turn every defect into a silent eviction, and one that
 * answered false to everything would have the writer retrying a disk that is full.
 *
 * The whole of the write happens in a worker with real OPFS behind it — that is proved in a
 * browser, in `tests/e2e/history.spec.ts`. What is left here is the one branch that can be
 * decided without a disk.
 */
describe('a refusal by quota', () => {
  it('is recognised by the name storage refuses under', () => {
    expect(isQuotaError(new DOMException('no room', 'QuotaExceededError'))).toBe(true)
  })

  it('is not confused with any other way a write can fail', () => {
    // NotAllowedError and NoModificationAllowedError are what a lock and a permission look like;
    // neither is helped by making room, and both would be swallowed by a looser test.
    expect(isQuotaError(new DOMException('locked', 'NoModificationAllowedError'))).toBe(false)
    expect(isQuotaError(new DOMException('denied', 'NotAllowedError'))).toBe(false)
    expect(isQuotaError(new TypeError('bytes is not a buffer'))).toBe(false)
  })

  it('survives what a rejected promise may hold instead of an error', () => {
    for (const thrown of [undefined, null, 'QuotaExceededError', 42, {}]) {
      expect(isQuotaError(thrown), `${String(thrown)} was taken for a full disk`).toBe(false)
    }
  })
})
