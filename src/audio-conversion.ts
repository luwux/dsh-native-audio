import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AudioAttachmentError } from './error.js'
import { parseWav } from './wav.js'

const AUDIO_FILE_NAME = /\.(?:wave?|aiff?|aifc|mp3|flac|m4a|aac|ogg|oga|opus)$/iu
const CONVERSION_TIMEOUT_MS = 120_000
/** `-fs` stops ffmpeg only after it passes the limit, so any stopped output is measurably over `maxBytes`. */
const OUTPUT_LIMIT_MARGIN_BYTES = 1024 * 1024
const ERROR_DETAIL_CHARS = 500
/**
 * Upload names cannot select a demuxer: ffmpeg probes content, and a playlist
 * demuxer would read other local files or URLs named inside the upload.
 */
const INPUT_RESTRICTIONS = ['-protocol_whitelist', 'file', '-format_whitelist', 'wav,aiff,mp3,flac,mov,aac,ogg']

/** Whether a file name has an extension that ingress and `read_audio` treat as audio. */
export function isAudioFileName(name: string): boolean {
  return AUDIO_FILE_NAME.test(name)
}

export interface ConvertAudioOptions {
  /** Largest accepted WAV; larger output is refused with `AUDIO_TOO_LARGE`. */
  maxBytes: number
  ffmpegPath: string
  signal?: AbortSignal
}

function isPcmWav(data: Uint8Array): boolean {
  try {
    parseWav(data)
    return true
  } catch (error) {
    if (error instanceof AudioAttachmentError) return false
    throw error
  }
}

/**
 * Return bytes `parseWav` accepts. PCM WAV input is returned as the same array;
 * anything else is decoded by ffmpeg to 16-bit PCM WAV at its own sample rate
 * and channel count. Identical input and ffmpeg build give identical output.
 */
export async function toPcmWav(data: Uint8Array, options: ConvertAudioOptions): Promise<Uint8Array> {
  if (isPcmWav(data)) return data
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-audio-'))
  try {
    const input = join(directory, 'input')
    const output = join(directory, 'output.wav')
    await writeFile(input, data, { mode: 0o600 })
    await runFfmpeg([
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      ...INPUT_RESTRICTIONS,
      '-i', input,
      '-map', '0:a:0', '-map_metadata', '-1',
      '-c:a', 'pcm_s16le', '-bitexact',
      '-fs', String(options.maxBytes + OUTPUT_LIMIT_MARGIN_BYTES),
      output,
    ], options)
    if ((await stat(output)).size > options.maxBytes) {
      throw new AudioAttachmentError('Converted audio exceeds the configured byte limit.', 'AUDIO_TOO_LARGE')
    }
    return new Uint8Array(await readFile(output))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function runFfmpeg(args: readonly string[], options: ConvertAudioOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(options.ffmpegPath, args, {
      timeout: CONVERSION_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
      } else if (options.signal?.aborted === true) {
        reject(options.signal.reason)
      } else if ('code' in error && error.code === 'ENOENT') {
        reject(new AudioAttachmentError(
          `Converting this audio to WAV requires ffmpeg, which was not found at "${options.ffmpegPath}".`,
          'AUDIO_CONVERTER_MISSING',
          { cause: error },
        ))
      } else {
        const detail = stderr.trim().slice(-ERROR_DETAIL_CHARS)
        reject(new AudioAttachmentError(
          `ffmpeg could not convert this audio to WAV${detail === '' ? '' : `: ${detail}`}`,
          'AUDIO_CONVERSION_FAILED',
          { cause: error },
        ))
      }
    })
  })
}
