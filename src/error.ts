const AUDIO_ADMISSION_ERROR_CODES = [
  'TOO_MANY_AUDIOS',
  'AUDIOS_TOO_LARGE',
  'UNSUPPORTED_AUDIO_TYPE',
  'INVALID_AUDIO_BASE64',
  'INVALID_AUDIO',
  'AUDIO_TYPE_MISMATCH',
  'AUDIO_TOO_LARGE',
  'AUDIO_CONVERTER_MISSING',
  'AUDIO_CONVERSION_FAILED',
] as const

export type AudioAdmissionErrorCode = typeof AUDIO_ADMISSION_ERROR_CODES[number]

export type AudioAttachmentErrorCode =
  | AudioAdmissionErrorCode
  | 'INVALID_ATTACHMENT_REF'
  | 'ATTACHMENT_CORRUPT'
  | 'ATTACHMENT_WRITE_FAILED'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_READ_FAILED'

const AUDIO_ADMISSION_ERROR_CODE_SET: ReadonlySet<string> = new Set(AUDIO_ADMISSION_ERROR_CODES)

/** Stable audio attachment failure with a machine-routable code. */
export class AudioAttachmentError extends Error {
  readonly code: AudioAttachmentErrorCode

  constructor(message: string, code: AudioAttachmentErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AudioAttachmentError'
    this.code = code
  }
}
/** Whether a caller can correct the proposed audio batch or bytes. */
export function isAudioAdmissionError(
  error: unknown,
): error is AudioAttachmentError & { readonly code: AudioAdmissionErrorCode } {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && AUDIO_ADMISSION_ERROR_CODE_SET.has(error.code)
}
