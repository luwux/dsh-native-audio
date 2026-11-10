/**
 * Content-addressed local WAV storage.
 *
 * Publication and read-verification mechanics are adapted from DeepSeek
 * Harness attachment-local at commit b150a551 under its MIT license. Audio
 * bytes remain byte-identical; image normalization code is not carried over.
 */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { AudioAttachmentId } from './brand.js'
import { AudioAttachmentError } from './error.js'
import type {
  AudioAttachmentLimits,
  AudioAttachmentRef,
  SaveAudioAttachment,
  StoredAudioAttachment,
} from './types.js'
import { parseWav } from './wav.js'

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const durableHomes = new Set<string>()

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

function ensureReference(ref: AudioAttachmentRef): string {
  const match = ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) {
    throw new AudioAttachmentError('Audio attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  }
  return match[1]
}

export function audioObjectPath(root: string, ref: AudioAttachmentRef): string {
  const sha256 = ensureReference(ref)
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

export interface PreparedAudioFile {
  data: Uint8Array
  ref: AudioAttachmentRef
}

export function prepareAudioFile(
  input: SaveAudioAttachment,
  limits: AudioAttachmentLimits,
): PreparedAudioFile {
  if (input.data.byteLength > limits.maxAudioBytes) {
    throw new AudioAttachmentError('Audio exceeds the configured byte limit.', 'AUDIO_TOO_LARGE')
  }
  const metadata = parseWav(input.data)
  if (metadata.mediaType !== input.mediaType) {
    throw new AudioAttachmentError('Declared audio type does not match its bytes.', 'AUDIO_TYPE_MISMATCH')
  }
  const sha256 = digest(input.data)
  const name = displayName(input.name)
  return {
    data: input.data,
    ref: {
      attachmentId: AudioAttachmentId(`sha256:${sha256}`),
      mediaType: metadata.mediaType,
      bytes: input.data.byteLength,
      sampleRateHz: metadata.sampleRateHz,
      channels: metadata.channels,
      bitsPerSample: metadata.bitsPerSample,
      validBitsPerSample: metadata.validBitsPerSample,
      ...(metadata.channelMask === undefined ? {} : { channelMask: metadata.channelMask }),
      sampleFrames: metadata.sampleFrames,
      encoding: metadata.encoding,
      ...(name === undefined ? {} : { name }),
    },
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function ensureDurableDirectory(path: string, boundary: string): Promise<void> {
  const target = resolve(path)
  const stop = resolve(boundary)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  let level = target
  while (level !== stop) {
    const parent = dirname(level)
    await syncDirectory(parent)
    if (parent === level) return
    level = parent
  }
}

async function ensureDurableHome(path: string): Promise<string> {
  const home = resolve(path)
  if (!durableHomes.has(home)) {
    await ensureDurableDirectory(home, parse(home).root)
    durableHomes.add(home)
  }
  return home
}

export async function commitPreparedAudioFile(
  root: string,
  prepared: PreparedAudioFile,
): Promise<AudioAttachmentRef> {
  const sha256 = ensureReference(prepared.ref)
  if (digest(prepared.data) !== sha256 || prepared.data.byteLength !== prepared.ref.bytes) {
    throw new AudioAttachmentError('Prepared audio bytes do not match their reference.', 'ATTACHMENT_CORRUPT')
  }
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const staging = join(root, 'tmp')
  const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
  await ensureDurableDirectory(bucket, boundary)
  await ensureDurableDirectory(staging, boundary)
  const temporary = join(staging, randomUUID())
  const target = audioObjectPath(root, prepared.ref)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(prepared.data)
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await link(temporary, target)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const existing = new Uint8Array(await readFile(target))
      if (digest(existing) !== sha256) {
        throw new AudioAttachmentError('Stored audio failed integrity verification.', 'ATTACHMENT_CORRUPT')
      }
    }
    await unlink(temporary)
    await chmod(target, 0o400)
    await syncDirectory(bucket)
    await syncDirectory(join(root, 'objects'))
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await unlink(temporary).catch((cleanupError: unknown) => {
      if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) {
        throw cleanupError
      }
    })
    if (error instanceof AudioAttachmentError) throw error
    throw new AudioAttachmentError('Unable to persist audio attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
  return prepared.ref
}

export async function saveAudioFile(
  root: string,
  input: SaveAudioAttachment,
  limits: AudioAttachmentLimits,
): Promise<AudioAttachmentRef> {
  return commitPreparedAudioFile(root, prepareAudioFile(input, limits))
}

export async function readAudioFile(
  root: string,
  ref: AudioAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredAudioAttachment> {
  signal?.throwIfAborted()
  const sha256 = ensureReference(ref)
  let data: Uint8Array
  try {
    data = new Uint8Array(await readFile(audioObjectPath(root, ref), { signal }))
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new AudioAttachmentError('Audio attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    }
    throw new AudioAttachmentError('Unable to read audio attachment.', 'ATTACHMENT_READ_FAILED', { cause: error })
  }
  signal?.throwIfAborted()
  if (digest(data) !== sha256) {
    throw new AudioAttachmentError('Stored audio failed integrity verification.', 'ATTACHMENT_CORRUPT')
  }
  const metadata = parseWav(data)
  if (data.byteLength !== ref.bytes
    || metadata.mediaType !== ref.mediaType
    || metadata.sampleRateHz !== ref.sampleRateHz
    || metadata.channels !== ref.channels
    || metadata.bitsPerSample !== ref.bitsPerSample
    || metadata.validBitsPerSample !== ref.validBitsPerSample
    || metadata.channelMask !== ref.channelMask
    || metadata.sampleFrames !== ref.sampleFrames
    || metadata.encoding !== ref.encoding) {
    throw new AudioAttachmentError('Stored audio metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { ref, data }
}
