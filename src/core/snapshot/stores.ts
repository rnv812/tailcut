import type { ReadRange } from './read'

export interface StoreFile {
  path: string
  bytes: number
}

/**
 * Several files read as one run of bytes: the address space an index of `stores` describes.
 *
 * The first file begins at zero and each one after it where the last ended, in the order they are
 * listed. That is the whole of the rule, and it is what lets a `Located` written by the layout of
 * one batch mean the same thing as one written into a snapshot file: so many bytes from the start
 * of the whole.
 *
 * A read that cannot be answered in full throws rather than coming back short. Everything
 * downstream — the sample index, the plan, the writer — trusts the length it asked for, and a
 * prefix would become a clip with its middle silently missing.
 */
export function composeStores(
  stores: readonly StoreFile[],
  readFile: (path: string, at: number, length: number) => Promise<Uint8Array>,
): ReadRange {
  const bases: number[] = []
  let size = 0
  for (const store of stores) {
    bases.push(size)
    size += store.bytes
  }

  return async (at: number, length: number): Promise<Uint8Array> => {
    if (length <= 0) return new Uint8Array(0)
    if (at < 0 || at + length > size) {
      throw new RangeError(`history: ${at}+${length} is outside the ${size} bytes there are`)
    }

    const out = new Uint8Array(length)
    let filled = 0

    for (let index = 0; index < stores.length; index++) {
      const base = bases[index]!
      const store = stores[index]!
      const from = Math.max(at, base)
      const to = Math.min(at + length, base + store.bytes)
      if (to <= from) continue

      const part = await readFile(store.path, from - base, to - from)
      if (part.byteLength !== to - from) {
        throw new Error(`history: ${store.path} answered ${part.byteLength} of ${to - from}`)
      }
      out.set(part, from - at)
      filled += to - from
    }

    if (filled !== length) throw new Error(`history: ${filled} bytes of the ${length} asked for`)
    return out
  }
}
