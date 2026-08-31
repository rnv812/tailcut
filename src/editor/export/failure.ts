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
