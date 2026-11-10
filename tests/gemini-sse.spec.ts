import { describe, expect, it } from 'vitest'
import { parseSseData, parseSseJson } from '../src/gemini/index.js'

function byteStream(bytes: Uint8Array, widths: readonly number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let offset = 0
      let widthIndex = 0
      while (offset < bytes.byteLength) {
        const width = widths[widthIndex % widths.length] ?? 1
        controller.enqueue(bytes.slice(offset, Math.min(offset + width, bytes.byteLength)))
        offset += width
        widthIndex += 1
      }
      controller.close()
    },
  })
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const value of values) result.push(value)
  return result
}

describe('Gemini SSE parser', () => {
  it('survives byte-hostile UTF-8 chunks, CRLF, comments, and multiline data', async () => {
    const wire = [
      '\uFEFF: keepalive\r\n',
      'event: message\r\n',
      'data: {"text":\r\n',
      'data: "音"}\r\n',
      'id: ignored\r\n',
      '\r\n',
      ': another comment\n',
      'data:{"done":true}\n',
      '\n',
      'data: [DONE]\r\n\r\n',
      'data: {"unreachable":true}\n\n',
    ].join('')
    const stream = byteStream(new TextEncoder().encode(wire), [1, 2, 1, 3])

    await expect(collect(parseSseData(stream))).resolves.toEqual([
      '{"text":\n"音"}',
      '{"done":true}',
    ])
  })

  it('dispatches a final data event at EOF and accepts standalone CR line endings', async () => {
    const stream = byteStream(new TextEncoder().encode('data: {"a":1}\r\rdata: {"b":2}'), [2])
    await expect(collect(parseSseJson(stream))).resolves.toEqual([{ a: 1 }, { b: 2 }])
  })

  it('rejects malformed JSON instead of treating a truncated stream as success', async () => {
    const stream = byteStream(new TextEncoder().encode('data: {"truncated":\n\n'), [1])
    await expect(collect(parseSseJson(stream))).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    })
  })

  it('cancels a pending reader promptly when the caller aborts', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const controller = new AbortController()
    const pending = collect(parseSseData(stream, controller.signal))
    controller.abort(new Error('stop streaming'))
    await expect(pending).rejects.toThrow('stop streaming')
    expect(cancelled).toBe(true)
  })
})
