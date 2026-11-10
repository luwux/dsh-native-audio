import { LlmError } from '@deepseek-ai/dsh-llm'

/** Incremental SSE decoder with CR, CRLF, LF, comments, and multiline data. */
class SseDecoder {
  private text = ''
  private data: string[] = []
  private firstLine = true

  feed(chunk: string, final = false): string[] {
    this.text += chunk
    const events: string[] = []
    let cursor = 0
    for (let index = 0; index < this.text.length; index += 1) {
      const character = this.text[index]
      if (character !== '\n' && character !== '\r') continue
      if (character === '\r' && index + 1 === this.text.length && !final) break
      const line = this.text.slice(cursor, index)
      if (character === '\r' && this.text[index + 1] === '\n') index += 1
      cursor = index + 1
      this.line(line, events)
    }
    this.text = this.text.slice(cursor)
    if (final) {
      if (this.text.length > 0) this.line(this.text, events)
      this.text = ''
      this.dispatch(events)
    }
    return events
  }

  private line(rawLine: string, events: string[]): void {
    const line = this.firstLine && rawLine.startsWith('\uFEFF') ? rawLine.slice(1) : rawLine
    this.firstLine = false
    if (line === '') {
      this.dispatch(events)
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
  }

  private dispatch(events: string[]): void {
    if (this.data.length === 0) return
    events.push(this.data.join('\n'))
    this.data = []
  }
}

/** Yield complete SSE `data:` payloads while respecting caller cancellation. */
export async function* parseSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const text = new TextDecoder()
  const sse = new SseDecoder()
  let completed = false
  try {
    while (true) {
      signal?.throwIfAborted()
      const next = signal === undefined
        ? await reader.read()
        : await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
            const aborted = (): void => reject(signal.reason)
            if (signal.aborted) {
              aborted()
              return
            }
            signal.addEventListener('abort', aborted, { once: true })
            reader.read().then(resolve, reject).finally(() => {
              signal.removeEventListener('abort', aborted)
            })
          })
      signal?.throwIfAborted()
      if (next.done) break
      for (const event of sse.feed(text.decode(next.value, { stream: true }))) {
        if (event === '[DONE]') {
          return
        }
        yield event
      }
    }
    for (const event of sse.feed(text.decode(), true)) {
      if (event === '[DONE]') break
      yield event
    }
    completed = true
  } finally {
    if (!completed) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Parse each SSE data payload as one complete JSON value. */
export async function* parseSseJson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  for await (const payload of parseSseData(body, signal)) {
    try {
      yield JSON.parse(payload) as unknown
    } catch (error) {
      throw new LlmError('Gemini SSE contained malformed JSON data', 'MALFORMED_RESPONSE', { cause: error })
    }
  }
}
