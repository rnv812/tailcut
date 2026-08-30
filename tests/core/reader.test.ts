import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { topLevelBoxes, findBox, childBoxes, boxBody, boxesIn } from '../../src/core/iso/reader'

const init = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const seg = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))

describe('topLevelBoxes', () => {
  it('finds ftyp and moov in the init segment', () => {
    const types = topLevelBoxes(init).map((b) => b.type)
    expect(types).toContain('ftyp')
    expect(types).toContain('moov')
  })

  it('finds moof and mdat in the media segment', () => {
    const types = topLevelBoxes(seg).map((b) => b.type)
    expect(types).toContain('moof')
    expect(types).toContain('mdat')
  })

  it('has box sizes cover the file without gaps', () => {
    const boxes = topLevelBoxes(init)
    expect(boxes.length).toBeGreaterThan(1)

    // Check continuity, not just total size. A gap offset by an overlap gives the same total even
    // though the parse is already wrong.
    expect(boxes[0]!.start).toBe(0)
    for (let i = 1; i < boxes.length; i++) {
      const prev = boxes[i - 1]!
      expect(boxes[i]!.start).toBe(prev.start + prev.size)
    }
    const last = boxes[boxes.length - 1]!
    expect(last.start + last.size).toBe(init.byteLength)

    const covered = boxes.reduce((sum, b) => sum + b.size, 0)
    expect(covered).toBe(init.byteLength)
  })
})

describe('findBox', () => {
  it('descends through a nested path', () => {
    const mdhd = findBox(init, ['moov', 'trak', 'mdia', 'mdhd'])
    expect(mdhd).not.toBeNull()
    expect(mdhd!.size).toBeGreaterThan(8)
  })

  it('returns null for a missing path', () => {
    expect(findBox(init, ['moov', 'nope'])).toBeNull()
  })

  it('stops at a missing intermediate segment instead of descending farther', () => {
    // trak exists inside moov, but it is reachable only through moov. A path through a nonexistent
    // intermediate container must return null.
    const moov = topLevelBoxes(init).find((b) => b.type === 'moov')!
    expect(childBoxes(init, moov).map((b) => b.type)).toContain('trak')
    expect(findBox(init, ['moov', 'nope', 'trak'])).toBeNull()
  })

  it('returns null when the first path segment is missing', () => {
    // moov is at the top level, but the path does not start with it. The reader must not skip a
    // mismatched segment and search for the next one at the same level.
    expect(topLevelBoxes(init).map((b) => b.type)).toContain('moov')
    expect(findBox(init, ['nope', 'moov'])).toBeNull()
  })

  it('returns the path leaf rather than a traversed container', () => {
    const moov = topLevelBoxes(init).find((b) => b.type === 'moov')!
    const mdhd = findBox(init, ['moov', 'trak', 'mdia', 'mdhd'])!
    expect(mdhd.type).toBe('mdhd')
    // The leaf lies strictly inside the container traversed to reach it.
    expect(mdhd.start).toBeGreaterThan(moov.start)
    expect(mdhd.start + mdhd.size).toBeLessThanOrEqual(moov.start + moov.size)
    expect(mdhd.size).toBeLessThan(moov.size)

    const tfhd = findBox(seg, ['moof', 'traf', 'tfhd'])!
    expect(tfhd.type).toBe('tfhd')
  })

  it('returns null for an empty path', () => {
    // An empty path names no box, so there is nothing to return. The top level is nonempty and its
    // first box is tempting, but that result would not match any requested segment.
    const top = topLevelBoxes(init)
    expect(top.length).toBeGreaterThan(0)
    expect(top[0]!.type).toBe('ftyp')
    expect(findBox(init, [])).toBeNull()
  })

  it('returns the top-level box itself for a one-segment path', () => {
    const moov = topLevelBoxes(init).find((b) => b.type === 'moov')!
    expect(findBox(init, ['moov'])).toEqual(moov)
  })
})

describe('childBoxes', () => {
  it('lists tracks inside moov', () => {
    const moov = topLevelBoxes(init).find((b) => b.type === 'moov')!
    const traks = childBoxes(init, moov).filter((b) => b.type === 'trak')
    expect(traks.length).toBeGreaterThanOrEqual(1)
  })

  it('does not parse a leaf box payload as boxes', () => {
    // The mdat payload happens to resemble box headers, but it has no children.
    const mdat = topLevelBoxes(seg).find((b) => b.type === 'mdat')!
    expect(mdat.size).toBeGreaterThan(mdat.headerSize)
    expect(childBoxes(seg, mdat)).toEqual([])

    const mdhd = findBox(init, ['moov', 'trak', 'mdia', 'mdhd'])!
    expect(mdhd.size).toBeGreaterThan(mdhd.headerSize)
    expect(childBoxes(init, mdhd)).toEqual([])
  })
})

// Synthetic buffers for cases absent from the fixtures.

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n)
  return out
}

function u64(n: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

const text = (data: Uint8Array): string => String.fromCharCode(...data)

describe('boxBody', () => {
  it('strips the ftyp header and returns the entire body', () => {
    const ftyp = topLevelBoxes(init).find((b) => b.type === 'ftyp')!
    const body = boxBody(init, ftyp)
    expect(body.byteLength).toBe(ftyp.size - ftyp.headerSize)
    // The first four bytes of the ftyp body are the major brand, not a box type.
    expect(text(body.subarray(0, 4))).toBe('iso5')
  })

  it('starts a container body with the first child header', () => {
    const moov = topLevelBoxes(init).find((b) => b.type === 'moov')!
    const body = boxBody(init, moov)
    const first = childBoxes(init, moov)[0]!
    expect(body.byteLength).toBe(moov.size - moov.headerSize)
    expect(new DataView(body.buffer, body.byteOffset).getUint32(0)).toBe(first.size)
    expect(text(body.subarray(4, 8))).toBe(first.type)
  })

  it('accounts for a 64-bit header', () => {
    const buf = concat(u32(1), ascii('mdat'), u64(24), ascii('PAYLOAD!'))
    const box = topLevelBoxes(buf)[0]!
    expect(text(boxBody(buf, box))).toBe('PAYLOAD!')
  })
})

describe('64-bit size', () => {
  it('reads largesize and a 16-byte header', () => {
    const buf = concat(u32(1), ascii('mdat'), u64(24), ascii('PAYLOAD!'))
    const boxes = topLevelBoxes(buf)
    expect(boxes).toEqual([{ type: 'mdat', start: 0, size: 24, headerSize: 16 }])
  })

  it('skips a box with a truncated 64-bit header', () => {
    const buf = concat(u32(1), ascii('mdat'), u32(0))
    expect(topLevelBoxes(buf)).toEqual([])
  })
})

describe('size 0 means a box extends to the end of the range', () => {
  it('extends a top-level box to the end of the buffer', () => {
    const buf = concat(u32(0), ascii('mdat'), ascii('12345678'))
    const boxes = topLevelBoxes(buf)
    expect(boxes).toEqual([{ type: 'mdat', start: 0, size: 16, headerSize: 8 }])
    expect(text(boxBody(buf, boxes[0]!))).toBe('12345678')
  })

  it('extends a nested box to the end of its parent rather than the buffer', () => {
    const traf = concat(u32(0), ascii('traf'), ascii('abcdefgh'))
    const moof = concat(u32(8 + traf.byteLength), ascii('moof'), traf)
    const buf = concat(moof, u32(8), ascii('free'))
    const parent = topLevelBoxes(buf).find((b) => b.type === 'moof')!
    expect(childBoxes(buf, parent)).toEqual([
      { type: 'traf', start: 8, size: 16, headerSize: 8 },
    ])
  })
})

describe('traversal boundary', () => {
  it('reads a box that occupies exactly the final eight bytes', () => {
    const buf = concat(u32(16), ascii('mdat'), ascii('12345678'), u32(8), ascii('free'))
    const boxes = topLevelBoxes(buf)
    expect(boxes.map((b) => b.type)).toEqual(['mdat', 'free'])
    expect(boxes[1]).toEqual({ type: 'free', start: 16, size: 8, headerSize: 8 })
  })

  it('reads an empty 64-bit box that occupies exactly the final 16 bytes', () => {
    // largesize == 16: the body is empty and the 16-byte header reaches the end of the range.
    // Exactly enough bytes are available for the header, so the box must be parsed rather than
    // discarded as truncated.
    const buf = concat(u32(16), ascii('mdat'), ascii('12345678'), u32(1), ascii('free'), u64(16))
    expect(buf.byteLength).toBe(32)
    const boxes = topLevelBoxes(buf)
    expect(boxes.map((b) => b.type)).toEqual(['mdat', 'free'])
    expect(boxes[1]).toEqual({ type: 'free', start: 16, size: 16, headerSize: 16 })
    expect(boxBody(buf, boxes[1]!).byteLength).toBe(0)
  })
})

describe('moof container', () => {
  it('lists traf inside moof', () => {
    const moof = topLevelBoxes(seg).find((b) => b.type === 'moof')!
    expect(childBoxes(seg, moof).map((b) => b.type)).toContain('traf')
  })

  it('descends through traf into fragment boxes', () => {
    const traf = findBox(seg, ['moof', 'traf'])!
    expect(traf.type).toBe('traf')

    const leaves = ['tfhd', 'tfdt', 'trun']
    const children = childBoxes(seg, traf)
    expect(children.map((b) => b.type)).toEqual(leaves)

    // Every leaf is exactly the box of that type inside traf, not merely a non-null value.
    expect(leaves.map((type) => findBox(seg, ['moof', 'traf', type]))).toEqual(children)

    // Together they tightly fill the traf body.
    let at = traf.start + traf.headerSize
    for (const box of children) {
      expect(box.start).toBe(at)
      expect(box.size).toBeGreaterThan(box.headerSize)
      at += box.size
    }
    expect(at).toBe(traf.start + traf.size)
  })
})

describe('container type set', () => {
  // The full list is pinned and deliberately duplicated here. Removing any type from reader.ts
  // must fail this test rather than silently narrowing traversal. The fixtures cover only some
  // types, so these boxes are synthetic: traversal itself matters, not realistic contents.
  const containers = [
    'moov', 'trak', 'mdia', 'minf', 'stbl', 'moof', 'traf', 'mvex', 'edts', 'dinf',
  ]

  // A `type` box containing one 16-byte free child.
  const withChild = (type: string): Uint8Array => {
    const child = concat(u32(16), ascii('free'), ascii('12345678'))
    return concat(u32(8 + child.byteLength), ascii(type), child)
  }

  it.each(containers)('childBoxes descends into %s', (type) => {
    const buf = withChild(type)
    const parent = topLevelBoxes(buf)[0]!
    expect(parent).toEqual({ type, start: 0, size: 24, headerSize: 8 })
    expect(childBoxes(buf, parent)).toEqual([
      { type: 'free', start: 8, size: 16, headerSize: 8 },
    ])
    // A path through this container also reaches the child.
    expect(findBox(buf, [type, 'free'])).toEqual({
      type: 'free', start: 8, size: 16, headerSize: 8,
    })
  })

  it.each(['ftyp', 'udta', 'mdat', 'mdhd'])('does not descend into %s', (type) => {
    // The set is an allowlist: the same byte layout under a non-container type must yield no
    // children.
    const buf = withChild(type)
    const parent = topLevelBoxes(buf)[0]!
    expect(parent.size).toBe(24)
    expect(childBoxes(buf, parent)).toEqual([])
    expect(findBox(buf, [type, 'free'])).toBeNull()
  })
})

describe('invalid sizes', () => {
  it('does not return a box whose declared size exceeds the buffer', () => {
    // Thirty-two bytes are declared but only 16 are available, so the box body has not arrived.
    const buf = concat(u32(32), ascii('mdat'), ascii('ABCDEFGH'))
    expect(buf.byteLength).toBe(16)
    expect(topLevelBoxes(buf)).toEqual([])
  })

  it('does not return a child that extends past its parent', () => {
    const traf = concat(u32(32), ascii('traf'), ascii('abcdefgh'))
    const moof = concat(u32(8 + traf.byteLength), ascii('moof'), traf)
    const buf = concat(moof, u32(8), ascii('free'))
    const parent = topLevelBoxes(buf).find((b) => b.type === 'moof')!
    expect(parent.size).toBe(24)
    // traf declares 32 bytes, but only 16 are available inside the parent.
    expect(childBoxes(buf, parent)).toEqual([])
  })

  it('bounds a child by its parent even when it fits in the buffer', () => {
    // traf declares 24 bytes. Only 16 are available inside moof, but 32 remain in the buffer, so
    // checking only the buffer boundary would accept it.
    const traf = concat(u32(24), ascii('traf'), ascii('abcdefgh'))
    const moof = concat(u32(8 + traf.byteLength), ascii('moof'), traf)
    const buf = concat(moof, u32(16), ascii('free'), ascii('SIBLING!'))
    expect(topLevelBoxes(buf).map((b) => b.type)).toEqual(['moof', 'free'])
    const parent = topLevelBoxes(buf)[0]!
    expect(parent.size).toBe(24)
    expect(parent.start + parent.headerSize + 24).toBeLessThanOrEqual(buf.byteLength)
    expect(childBoxes(buf, parent)).toEqual([])
  })

  it('does not return a box that is exactly one byte short', () => {
    // Sixteen bytes are declared but only 15 are available, leaving the body one byte short. The
    // body must fit entirely in the range or the box does not exist. Allowing an almost-fit would
    // return a box whose last byte lies beyond the parsed data.
    const buf = concat(u32(16), ascii('mdat'), ascii('1234567'))
    expect(buf.byteLength).toBe(15)
    expect(topLevelBoxes(buf)).toEqual([])

    // Add the missing byte and the same box parses completely.
    const full = concat(buf, ascii('8'))
    expect(full.byteLength).toBe(16)
    expect(topLevelBoxes(full)).toEqual([
      { type: 'mdat', start: 0, size: 16, headerSize: 8 },
    ])
    expect(text(boxBody(full, topLevelBoxes(full)[0]!))).toBe('12345678')
  })

  it('does not return a child that is one byte short of its parent boundary', () => {
    // traf declares 17 bytes, but only 16 are available inside moof. The missing byte exists in
    // the buffer immediately after the parent, but it belongs elsewhere.
    const traf = concat(u32(17), ascii('traf'), ascii('abcdefgh'))
    const moof = concat(u32(8 + traf.byteLength), ascii('moof'), traf)
    const buf = concat(moof, u32(8), ascii('free'))
    const parent = topLevelBoxes(buf)[0]!
    expect(parent).toEqual({ type: 'moof', start: 0, size: 24, headerSize: 8 })
    expect(parent.start + parent.headerSize + 17).toBeLessThanOrEqual(buf.byteLength)
    expect(childBoxes(buf, parent)).toEqual([])
  })

  it('does not return a box smaller than its header', () => {
    const buf = concat(u32(4), ascii('mdat'), u32(8), ascii('free'))
    expect(topLevelBoxes(buf)).toEqual([])
  })

  it('does not return a 64-bit box whose largesize is smaller than its header', () => {
    // largesize == 8 with a 16-byte header would give the body a negative length.
    const buf = concat(u32(1), ascii('mdat'), u64(8), ascii('PAYLOAD!'))
    expect(topLevelBoxes(buf)).toEqual([])
  })

  it('stops traversal at a 64-bit box with largesize 0', () => {
    // size == 1 and largesize == 0: the size is below the 16-byte header and there is no advance.
    // Traversal must stop at the size < headerSize check or the offset would remain fixed and the
    // loop would run forever.
    const buf = concat(u32(1), ascii('mdat'), u64(0), ascii('PAYLOAD!'))
    expect(topLevelBoxes(buf)).toEqual([])
  })
})

describe('container with a 64-bit header', () => {
  it('lists children starting at parent.start + 16', () => {
    const traf = concat(u32(16), ascii('traf'), ascii('abcdefgh'))
    const moof = concat(u32(1), ascii('moof'), u64(16 + traf.byteLength), traf)
    const parent = topLevelBoxes(moof)[0]!
    expect(parent).toEqual({ type: 'moof', start: 0, size: 32, headerSize: 16 })
    expect(childBoxes(moof, parent)).toEqual([
      { type: 'traf', start: 16, size: 16, headerSize: 8 },
    ])
  })
})

describe('same-named boxes at one level', () => {
  it('has findBox return the first same-named child', () => {
    const first = concat(u32(16), ascii('trak'), ascii('FIRST!!!'))
    const second = concat(u32(24), ascii('trak'), ascii('SECOND!!SECOND!!'))
    const buf = concat(
      u32(8 + first.byteLength + second.byteLength), ascii('moov'), first, second,
    )

    const children = childBoxes(buf, topLevelBoxes(buf)[0]!)
    expect(children).toEqual([
      { type: 'trak', start: 8, size: 16, headerSize: 8 },
      { type: 'trak', start: 24, size: 24, headerSize: 8 },
    ])

    // Buffer order resolves same-named children: the first one wins.
    const found = findBox(buf, ['moov', 'trak'])!
    expect(found).toEqual(children[0])
    expect(text(boxBody(buf, found))).toBe('FIRST!!!')
  })

  it('has findBox descend into the first same-named top-level box', () => {
    const moofWith = (payload: string): Uint8Array =>
      concat(u32(24), ascii('moof'), u32(16), ascii('traf'), ascii(payload))
    const buf = concat(moofWith('FIRST!!!'), moofWith('SECOND!!'))

    const top = topLevelBoxes(buf)
    expect(top).toEqual([
      { type: 'moof', start: 0, size: 24, headerSize: 8 },
      { type: 'moof', start: 24, size: 24, headerSize: 8 },
    ])

    expect(findBox(buf, ['moof'])).toEqual(top[0])
    // The rest of the path descends into the first one, not the last.
    const traf = findBox(buf, ['moof', 'traf'])!
    expect(traf).toEqual({ type: 'traf', start: 8, size: 16, headerSize: 8 })
    expect(text(boxBody(buf, traf))).toBe('FIRST!!!')
  })
})

describe('view with a nonzero byteOffset', () => {
  // moof is not at the start of the underlying ArrayBuffer. Plausible junk before it parses as two
  // boxes on its own. Offsets must be relative to the start of the view or sizes are read from the
  // wrong location and parsing silently becomes incorrect.
  const junk = concat(u32(8), ascii('free'), u32(8), ascii('skip'))
  const traf = concat(u32(16), ascii('traf'), ascii('abcdefgh'))
  const moof = concat(u32(8 + traf.byteLength), ascii('moof'), traf)
  const standalone = concat(moof, u32(8), ascii('free'))
  const padded = concat(junk, standalone)
  const slice = padded.subarray(junk.byteLength)

  it('matches the view top level to a standalone buffer', () => {
    expect(slice.byteOffset).toBe(16)
    expect(standalone.byteOffset).toBe(0)
    expect([...slice]).toEqual([...standalone])

    expect(topLevelBoxes(slice)).toEqual(topLevelBoxes(standalone))
    expect(topLevelBoxes(slice)).toEqual([
      { type: 'moof', start: 0, size: 24, headerSize: 8 },
      { type: 'free', start: 24, size: 8, headerSize: 8 },
    ])
  })

  it('matches children inside the view to a standalone buffer', () => {
    const parent = topLevelBoxes(standalone).find((b) => b.type === 'moof')!
    expect(childBoxes(slice, parent)).toEqual(childBoxes(standalone, parent))
    expect(childBoxes(slice, parent)).toEqual([
      { type: 'traf', start: 8, size: 16, headerSize: 8 },
    ])
  })

  it('does not read past a view that has a trailing buffer region', () => {
    // This resembles a view passed to appendBuffer: a window in the middle of a larger buffer with
    // bytes before and after it. Traversal ends at the view boundary. Using the remaining buffer
    // would parse unrelated bytes after the view.
    const tail = concat(u32(16), ascii('mdat'), ascii('TAILTAIL'))
    const whole = concat(junk, standalone, tail)
    const middle = whole.subarray(junk.byteLength, junk.byteLength + standalone.byteLength)

    expect(middle.byteOffset).toBe(junk.byteLength)
    expect(middle.byteOffset).toBeGreaterThan(0)
    expect(middle.byteOffset + middle.byteLength).toBeLessThan(middle.buffer.byteLength)
    expect([...middle]).toEqual([...standalone])

    expect(topLevelBoxes(middle)).toEqual(topLevelBoxes(standalone))
    expect(topLevelBoxes(middle)).toEqual([
      { type: 'moof', start: 0, size: 24, headerSize: 8 },
      { type: 'free', start: 24, size: 8, headerSize: 8 },
    ])
    // The trailing mdat lies outside the window and must not be parsed.
    expect(topLevelBoxes(middle).map((b) => b.type)).not.toContain('mdat')
  })

  it('parses a container body from boxBody like a standalone buffer', () => {
    const moovBox = topLevelBoxes(init).find((b) => b.type === 'moov')!
    const body = boxBody(init, moovBox)
    expect(body.byteOffset).toBe(moovBox.start + moovBox.headerSize)
    expect(body.byteOffset).toBeGreaterThan(0)

    // The same byte sequence, but at the start of its own buffer.
    const detached = new Uint8Array(body)
    expect(detached.byteOffset).toBe(0)

    expect(topLevelBoxes(body)).toEqual(topLevelBoxes(detached))
    // These are exactly the moov children with starts converted to body-relative coordinates.
    expect(topLevelBoxes(body)).toEqual(
      childBoxes(init, moovBox).map((b) => ({ ...b, start: b.start - body.byteOffset })),
    )

    const trakInBody = topLevelBoxes(body).find((b) => b.type === 'trak')!
    expect(childBoxes(body, trakInBody)).toEqual(childBoxes(detached, trakInBody))
    expect(childBoxes(body, trakInBody).map((b) => b.type)).toEqual(
      childBoxes(init, findBox(init, ['moov', 'trak'])!).map((b) => b.type),
    )
  })
})

describe('boxesIn', () => {
  it('reads the boxes of a range whose parent is not a container', () => {
    // stsd is a full box: four bytes of version and flags, four of entry count, and only then the
    // sample entries. It is not in the container list and cannot be — the eight bytes in front of
    // its children would be read as a box header — so childBoxes hands back nothing for it.
    const stsd = findBox(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])!
    expect(childBoxes(init, stsd)).toEqual([])

    const entries = boxesIn(init, stsd.start + stsd.headerSize + 8, stsd.start + stsd.size)
    expect(entries.map((b) => b.type)).toEqual(['avc1'])
    expect(entries[0]!.size).toBe(170)

    // The same for the sample entry itself: a fixed run of fields, then the boxes describing the
    // codec. Eighty-six bytes in for a picture — see src/core/iso/entry.ts.
    const entry = entries[0]!
    const children = boxesIn(init, entry.start + 86, entry.start + entry.size)
    expect(children.map((b) => b.type)).toEqual(['avcC', 'pasp', 'btrt'])
  })

  it('stops at the end of the range and not at the end of the buffer', () => {
    const stsd = findBox(init, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])!
    const entry = boxesIn(init, stsd.start + stsd.headerSize + 8, stsd.start + stsd.size)[0]!
    const avcC = boxesIn(init, entry.start + 86, entry.start + entry.size)[0]!

    // A range that ends one byte short of the pasp behind the avcC yields the avcC alone: the box
    // that does not fit is dropped rather than half-read.
    const narrow = boxesIn(init, entry.start + 86, avcC.start + avcC.size + 15)
    expect(narrow.map((b) => b.type)).toEqual(['avcC'])

    // An empty range and a backwards one are both nothing, not a throw.
    expect(boxesIn(init, 8, 8)).toEqual([])
    expect(boxesIn(init, 32, 8)).toEqual([])
  })
})
