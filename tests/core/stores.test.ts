import { describe, it, expect } from 'vitest'
import { composeStores } from '../../src/core/snapshot/stores'

const files: Record<string, Uint8Array> = {
  'a.tcm': new Uint8Array([0, 1, 2, 3, 4]),
  'b.tcm': new Uint8Array([5, 6, 7]),
  'c.tcm': new Uint8Array([8, 9]),
}

const asked: string[] = []
const readFile = async (path: string, at: number, length: number) => {
  asked.push(`${path}@${at}+${length}`)
  return files[path]!.subarray(at, at + length)
}

const stores = [
  { path: 'a.tcm', bytes: 5 },
  { path: 'b.tcm', bytes: 3 },
  { path: 'c.tcm', bytes: 2 },
]

describe('composeStores', () => {
  it('reads inside one file without touching the others', async () => {
    asked.length = 0
    expect([...(await composeStores(stores, readFile)(1, 3))]).toEqual([1, 2, 3])
    expect(asked).toEqual(['a.tcm@1+3'])
  })

  it('reads across a seam and gives back one run of bytes', async () => {
    asked.length = 0
    expect([...(await composeStores(stores, readFile)(3, 4))]).toEqual([3, 4, 5, 6])
    expect(asked).toEqual(['a.tcm@3+2', 'b.tcm@0+2'])
  })

  it('reads across every file at once', async () => {
    expect([...(await composeStores(stores, readFile)(0, 10))]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('gives back nothing for a length of nothing', async () => {
    expect((await composeStores(stores, readFile)(4, 0)).byteLength).toBe(0)
  })

  it('refuses to answer short: a missing piece is not a shorter clip', async () => {
    // The sweeper took a file between two reads. A prefix here would become a clip with the
    // middle silently missing, and every reader downstream trusts the length it asked for.
    const broken = async (path: string, at: number, length: number) => {
      if (path === 'b.tcm') throw new Error('gone')
      return readFile(path, at, length)
    }
    await expect(composeStores(stores, broken)(0, 10)).rejects.toThrow()
  })

  it('refuses a range past the end of the whole', async () => {
    await expect(composeStores(stores, readFile)(8, 5)).rejects.toThrow()
  })
})
