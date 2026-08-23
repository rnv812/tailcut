import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { assembleFragmentedMp4 } from '../../src/core/assemble'
import { topLevelBoxes } from '../../src/core/iso/reader'
import type { Run } from '../../src/shared/types'

const init = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const seg1 = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))
const seg2 = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00002.m4s'))

/** Слепок байтов: сравнение целых буферов, не заваливающее вывод при расхождении. */
function digest(...parts: Uint8Array[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest('hex')
}

/** Те же байты внутри буфера пошире: вид с ненулевым смещением, а не владелец буфера. */
function viewWithOffset(bytes: Uint8Array): Uint8Array {
  const offset = 9
  const backing = new Uint8Array(offset + bytes.byteLength + 7).fill(0xaa)
  backing.set(bytes, offset)
  return backing.subarray(offset, offset + bytes.byteLength)
}

const run: Run = {
  start: 0,
  end: 4,
  chunks: [
    { start: 0, end: 2, bytes: seg1 },
    { start: 2, end: 4, bytes: seg2 },
  ],
}

describe('assembleFragmentedMp4', () => {
  it('складывает init и фрагменты в один буфер', () => {
    const out = assembleFragmentedMp4(init, run)
    expect(out.byteLength).toBe(init.byteLength + seg1.byteLength + seg2.byteLength)
  })

  it('байты идут подряд и в порядке прогона', () => {
    expect(digest(assembleFragmentedMp4(init, run))).toBe(digest(init, seg1, seg2))
  })

  it('берёт тело вида, а не буфер под ним', () => {
    const out = assembleFragmentedMp4(viewWithOffset(init), {
      start: 0,
      end: 4,
      chunks: [
        { start: 0, end: 2, bytes: viewWithOffset(seg1) },
        { start: 2, end: 4, bytes: viewWithOffset(seg2) },
      ],
    })

    expect(out.byteLength).toBe(init.byteLength + seg1.byteLength + seg2.byteLength)
    expect(digest(out)).toBe(digest(init, seg1, seg2))
  })

  it('на выходе валидная последовательность боксов', () => {
    const types = topLevelBoxes(assembleFragmentedMp4(init, run)).map((b) => b.type)
    expect(types[0]).toBe('ftyp')
    expect(types).toContain('moov')
    expect(types.filter((t) => t === 'moof')).toHaveLength(2)
  })

  it('ffprobe читает файл: ожидаемая длительность, все кадры, пустой stderr', () => {
    mkdirSync('tests/tmp', { recursive: true })
    const file = 'tests/tmp/assembled.mp4'
    writeFileSync(file, assembleFragmentedMp4(init, run))

    // -count_frames гонит ffprobe по всем пакетам, а не только по заголовкам: порча
    // внутри mdat заголовки не ломает и видна лишь при разборе кадров — жалобой в stderr.
    const probe = spawnSync(
      'ffprobe',
      [
        '-v', 'error',
        '-count_frames',
        '-show_entries', 'format=duration:stream=nb_read_frames',
        '-of', 'json',
        file,
      ],
      { encoding: 'utf8' },
    )

    expect(probe.error).toBeUndefined()
    expect(probe.status, probe.stderr).toBe(0)
    expect(probe.stderr, 'ffprobe жалуется на разбор файла').toBe('')

    const probed = JSON.parse(probe.stdout) as {
      format: { duration: string }
      streams: Array<{ nb_read_frames: string }>
    }

    const seconds = Number(probed.format.duration)
    expect(seconds).toBeGreaterThan(3.5)
    expect(seconds).toBeLessThan(4.5)
    // 4 секунды исходника при 24 кадрах в секунду: оба фрагмента дошли целиком
    expect(probed.streams.map((stream) => Number(stream.nb_read_frames))).toEqual([96])
  })

  it('пустой прогон даёт только init', () => {
    const out = assembleFragmentedMp4(init, { start: 0, end: 0, chunks: [] })
    expect(out.byteLength).toBe(init.byteLength)
    expect(digest(out)).toBe(digest(init))
  })
})
