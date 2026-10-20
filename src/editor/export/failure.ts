export class CodecFailure extends Error {
  constructor(
    readonly stage: 'decode' | 'encode',
    readonly causeName: string,
    readonly causeMessage: string,
    message: string,
  ) {
    super(message)
    this.name = 'CodecFailure'
  }
}

/** The one encoder refusal that a CPU-backed copy can change. */
export const unexpectedFrameFormat = (failure: CodecFailure): boolean =>
  failure.stage === 'encode' &&
  failure.causeName === 'OperationError' &&
  failure.causeMessage.includes('Unexpected frame format')

/** A WebCodecs failure with enough context to identify which half of an export rejected which codec. */
export function codecFailure(
  stage: 'decode' | 'encode',
  sourceCodec: string,
  targetCodec: string | null,
  cause: unknown,
): Error {
  const record =
    typeof cause === 'object' && cause !== null
      ? (cause as { name?: unknown; message?: unknown })
      : null
  const name = typeof record?.name === 'string' && record.name ? record.name : 'Error'
  const message =
    typeof record?.message === 'string' && record.message ? record.message : String(cause)
  const operation =
    stage === 'decode'
      ? `Decoding ${sourceCodec}`
      : `Encoding ${sourceCodec} to ${targetCodec ?? 'unknown'}`

  return new CodecFailure(stage, name, message, `${operation} failed (${name}): ${message}`)
}

/** One encoder that was tried and failed: the codec it was asked for, where it ran, and why. */
export interface FailedAttempt {
  codec: string
  where: 'hardware' | 'software'
  failure: CodecFailure
}

/**
 * Every encoder that failed, in one sentence — the last failure alone is not the story.
 *
 * Measured on the browser this exists for: Yandex on Windows has a hardware H.264 encoder that
 * answers the probe yes and then fails, and no OpenH264 behind it. Told only the last refusal, the
 * user read "Failed to create OpenH264 encoder" and nothing about the hardware encoder that went
 * first, nor anything that would tell the two machines apart. One attempt keeps the plain form of
 * `codecFailure`, so nothing changes for the common case; the cause fields are the last
 * attempt's, so a caller that inspects them still sees a real browser failure.
 */
export function exhaustedFailure(
  sourceCodec: string,
  attempts: readonly FailedAttempt[],
  note = '',
): CodecFailure {
  const last = attempts[attempts.length - 1]!
  if (attempts.length === 1 && !note) return last.failure

  const each = attempts.map(
    ({ codec, where, failure }) =>
      `${codec} (${where}): ${failure.causeName}: ${failure.causeMessage}`,
  )
  const message =
    attempts.length === 1
      ? `${last.failure.message}${note}`
      : `Encoding ${sourceCodec} failed on every encoder tried: ${each.join('; ')}${note}`
  return new CodecFailure('encode', last.failure.causeName, last.failure.causeMessage, message)
}
