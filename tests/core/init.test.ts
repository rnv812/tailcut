import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseInit } from '../../src/core/iso/init'

const h264 = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream0.m4s'))
const vp9 = new Uint8Array(readFileSync('tests/fixtures/vp9/init-stream0.m4s'))
const media = new Uint8Array(readFileSync('tests/fixtures/h264/chunk-stream0-00001.m4s'))

describe('parseInit', () => {
  it('читает видеодорожку H.264', () => {
    const info = parseInit(h264)!
    expect(info).not.toBeNull()
    const video = info.tracks.find((t) => t.kind === 'video')!
    expect(video.codec).toBe('avc1')
    expect(video.width).toBe(320)
    expect(video.height).toBe(240)
    expect(video.timescale).toBeGreaterThan(0)
    expect(video.trackId).toBeGreaterThan(0)
  })

  it('читает видеодорожку VP9 — разбор не заточен под один кодек', () => {
    const video = parseInit(vp9)!.tracks.find((t) => t.kind === 'video')!
    expect(video.codec).toBe('vp09')
  })

  it('читает аудиодорожку', () => {
    const audioInit = new Uint8Array(readFileSync('tests/fixtures/h264/init-stream1.m4s'))
    const audio = parseInit(audioInit)!.tracks.find((t) => t.kind === 'audio')!
    expect(audio.codec).toBe('mp4a')
    expect(audio.timescale).toBeGreaterThan(0)
  })

  it('возвращает null, если moov отсутствует', () => {
    expect(parseInit(media)).toBeNull()
  })
})
