import { createHash } from 'node:crypto'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AudioAttachmentRef } from '../types.js'

const FILE_ID_PREFIX = 'dsh-audio-'
const FILE_NAMESPACE_HEX_LENGTH = 10
const FILE_CONTENT_HEX_LENGTH = 19
const EXPIRATION_SKEW_MS = 60_000
const PROCESSING_TIMEOUT_MS = 60_000

export interface GeminiAudioUpload {
  readonly attachment: AudioAttachmentRef
  readonly data: Uint8Array
  readonly fileName: string
  readonly fileUri: string
  readonly sha256: string
}

export interface GeminiFileFetchOptions {
  readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
  readonly baseUrl: string
  readonly apiKey: string
  readonly signal?: AbortSignal
}

interface ActiveFile {
  readonly fileUri: string
  readonly expirationMs: number
}

interface GeminiFileResource {
  readonly name: string
  readonly mimeType: string
  readonly sizeBytes: string
  readonly expirationTime: string
  readonly sha256Hash: string
  readonly uri: string
  readonly state: 'PROCESSING' | 'ACTIVE' | 'FAILED'
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

export function geminiCredentialNamespace(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, FILE_NAMESPACE_HEX_LENGTH)
}

export function geminiFileName(sha256: string, credentialNamespace: string): string {
  return `files/${FILE_ID_PREFIX}${credentialNamespace}-${sha256.slice(0, FILE_CONTENT_HEX_LENGTH)}`
}

export function geminiFileUri(baseUrl: string, fileName: string): string {
  return `${normalizedBaseUrl(baseUrl)}/v1beta/${fileName}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function transportCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'INVALID_REQUEST'
}

async function failedResponse(operation: string, response: Response): Promise<LlmError> {
  const detail = (await response.text().catch(() => '')).trim()
  return new LlmError(
    detail === '' ? `Gemini Files ${operation} returned HTTP ${response.status}` : detail,
    transportCode(response.status),
    { status: response.status },
  )
}

function parseFile(value: unknown, operation: string): GeminiFileResource {
  const candidate = isRecord(value) && isRecord(value['file']) ? value['file'] : value
  if (!isRecord(candidate)
    || typeof candidate['name'] !== 'string'
    || typeof candidate['mimeType'] !== 'string'
    || typeof candidate['sizeBytes'] !== 'string'
    || typeof candidate['expirationTime'] !== 'string'
    || typeof candidate['sha256Hash'] !== 'string'
    || typeof candidate['uri'] !== 'string'
    || (candidate['state'] !== 'PROCESSING'
      && candidate['state'] !== 'ACTIVE'
      && candidate['state'] !== 'FAILED')) {
    throw new LlmError(`Gemini Files ${operation} returned malformed metadata`, 'MALFORMED_RESPONSE')
  }
  return candidate as unknown as GeminiFileResource
}

function verifyFile(file: GeminiFileResource, upload: GeminiAudioUpload): ActiveFile | undefined {
  const expectedHash = Buffer.from(upload.sha256, 'utf8').toString('base64')
  const expirationMs = Date.parse(file.expirationTime)
  if (file.name !== upload.fileName
    || file.uri !== upload.fileUri
    || file.mimeType !== upload.attachment.mediaType
    || file.sizeBytes !== String(upload.data.byteLength)
    || file.sha256Hash !== expectedHash
    || !Number.isFinite(expirationMs)) {
    throw new LlmError(`Gemini Files metadata does not match ${upload.fileName}`, 'MALFORMED_RESPONSE')
  }
  if (file.state === 'FAILED') {
    throw new LlmError(`Gemini Files processing failed for ${upload.fileName}`, 'INVALID_REQUEST')
  }
  return file.state === 'ACTIVE' ? { fileUri: file.uri, expirationMs } : undefined
}

async function fetchFile(
  upload: GeminiAudioUpload,
  options: GeminiFileFetchOptions,
): Promise<GeminiFileResource | undefined> {
  let response: Response
  try {
    response = await options.fetch(upload.fileUri, {
      method: 'GET',
      headers: { 'x-goog-api-key': options.apiKey },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    options.signal?.throwIfAborted()
    throw new LlmError('Gemini Files metadata request failed', 'TRANSPORT', { cause: error })
  }
  // The Files API uses 403 for a caller-supplied name that is absent from the
  // current credential's file space. Upload start remains the auth check.
  if (response.status === 403 || response.status === 404) return undefined
  if (!response.ok) throw await failedResponse('metadata request', response)
  return parseFile(await response.json(), 'metadata request')
}

async function uploadFile(
  upload: GeminiAudioUpload,
  options: GeminiFileFetchOptions,
): Promise<GeminiFileResource> {
  const startUrl = `${normalizedBaseUrl(options.baseUrl)}/upload/v1beta/files`
  let start: Response
  try {
    start = await options.fetch(startUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': options.apiKey,
        'x-goog-upload-protocol': 'resumable',
        'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-length': String(upload.data.byteLength),
        'x-goog-upload-header-content-type': upload.attachment.mediaType,
      },
      body: JSON.stringify({
        file: {
          name: upload.fileName,
          displayName: `${FILE_ID_PREFIX}${upload.sha256.slice(0, 12)}.wav`,
        },
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    options.signal?.throwIfAborted()
    throw new LlmError('Gemini Files upload start failed', 'TRANSPORT', { cause: error })
  }
  if (!start.ok) throw await failedResponse('upload start', start)
  const uploadUrl = start.headers.get('x-goog-upload-url')
  if (uploadUrl === null || uploadUrl.length === 0) {
    throw new LlmError('Gemini Files upload start returned no upload URL', 'MALFORMED_RESPONSE')
  }

  let finalized: Response
  try {
    finalized = await options.fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'content-length': String(upload.data.byteLength),
        'content-type': upload.attachment.mediaType,
        'x-goog-upload-offset': '0',
        'x-goog-upload-command': 'upload, finalize',
      },
      body: Buffer.from(upload.data),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    options.signal?.throwIfAborted()
    throw new LlmError('Gemini Files byte upload failed', 'TRANSPORT', { cause: error })
  }
  if (!finalized.ok) throw await failedResponse('byte upload', finalized)
  return parseFile(await finalized.json(), 'byte upload')
}

function credentialKey(options: GeminiFileFetchOptions, upload: GeminiAudioUpload): string {
  const credential = createHash('sha256').update(options.apiKey).digest('hex')
  return `${normalizedBaseUrl(options.baseUrl)}\u0000${credential}\u0000${upload.fileName}`
}

interface PendingFile {
  readonly controller: AbortController
  readonly promise: Promise<ActiveFile>
  waiters: number
}

function waitForFile(promise: Promise<ActiveFile>, signal?: AbortSignal): Promise<ActiveFile> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Reuse files across callers; a caller cancels only its own wait. */
export class GeminiFileCache {
  private readonly active = new Map<string, ActiveFile>()
  private readonly pending = new Map<string, PendingFile>()

  async ensure(upload: GeminiAudioUpload, options: GeminiFileFetchOptions): Promise<ActiveFile> {
    options.signal?.throwIfAborted()
    const key = credentialKey(options, upload)
    const active = this.active.get(key)
    if (active !== undefined && active.expirationMs - EXPIRATION_SKEW_MS > Date.now()) return active
    let pending = this.pending.get(key)
    if (pending === undefined) {
      const controller = new AbortController()
      const promise = this.ensureUncached(upload, {
        ...options,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(PROCESSING_TIMEOUT_MS)]),
      })
      pending = { controller, promise, waiters: 0 }
      const entry = pending
      this.pending.set(key, entry)
      void promise.then(result => {
        if (!controller.signal.aborted) this.active.set(key, result)
      }, () => {}).finally(() => {
        if (this.pending.get(key) === entry) this.pending.delete(key)
      })
    }
    pending.waiters += 1
    try {
      return await waitForFile(pending.promise, options.signal)
    } finally {
      pending.waiters -= 1
      if (pending.waiters === 0 && this.pending.get(key) === pending) {
        this.pending.delete(key)
        pending.controller.abort(new Error('all Gemini File callers cancelled'))
      }
    }
  }

  async ensureAll(
    uploads: readonly GeminiAudioUpload[],
    options: GeminiFileFetchOptions,
  ): Promise<void> {
    await Promise.all(uploads.map(upload => this.ensure(upload, options)))
  }

  private async ensureUncached(
    upload: GeminiAudioUpload,
    options: GeminiFileFetchOptions,
  ): Promise<ActiveFile> {
    let file = await fetchFile(upload, options)
    if (file === undefined) file = await uploadFile(upload, options)
    let active = verifyFile(file, upload)
    const deadline = Date.now() + PROCESSING_TIMEOUT_MS
    while (active === undefined) {
      if (Date.now() >= deadline) {
        throw new LlmError(`Gemini File ${upload.fileName} did not become active in time`, 'TIMEOUT')
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timeout)
          reject(options.signal?.reason)
        }
        const timeout = setTimeout(() => {
          options.signal?.removeEventListener('abort', onAbort)
          resolve()
        }, 500)
        options.signal?.addEventListener('abort', onAbort, { once: true })
      })
      options.signal?.throwIfAborted()
      const current = await fetchFile(upload, options)
      if (current === undefined) {
        throw new LlmError(`Gemini File ${upload.fileName} disappeared while processing`, 'INVALID_REQUEST')
      }
      active = verifyFile(current, upload)
    }
    return active
  }
}
