export interface SyntheticWavOptions {
  sampleRateHz?: number
  channels?: number
  frames?: number
  bitsPerSample?: 8 | 16 | 24 | 32
  format?: 'classic' | 'extensible'
  validBitsPerSample?: number
  channelMask?: number
  junkBeforeFormat?: boolean
  listBeforeData?: boolean
  /** Pad a classic fmt chunk to this size, as Ableton factory samples do. */
  classicFmtBytes?: number
}

function writeAscii(output: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) output[offset + index] = value.charCodeAt(index)
}

function chunk(id: string, body: Uint8Array): Uint8Array {
  const output = new Uint8Array(8 + body.byteLength + (body.byteLength % 2))
  writeAscii(output, 0, id)
  new DataView(output.buffer).setUint32(4, body.byteLength, true)
  output.set(body, 8)
  return output
}

/** Build deterministic integer-PCM RIFF/WAVE bytes without copied music. */
export function syntheticWav(options: SyntheticWavOptions = {}): Uint8Array {
  const sampleRateHz = options.sampleRateHz ?? 8000
  const channels = options.channels ?? 1
  const frames = options.frames ?? 80
  const bitsPerSample = options.bitsPerSample ?? 16
  const format = options.format ?? 'classic'
  const blockAlign = channels * (bitsPerSample / 8)
  const dataBytes = frames * blockAlign
  const fmt = new Uint8Array(format === 'classic' ? options.classicFmtBytes ?? 16 : 40)
  const fmtView = new DataView(fmt.buffer)
  fmtView.setUint16(0, format === 'classic' ? 0x0001 : 0xfffe, true)
  fmtView.setUint16(2, channels, true)
  fmtView.setUint32(4, sampleRateHz, true)
  fmtView.setUint32(8, sampleRateHz * blockAlign, true)
  fmtView.setUint16(12, blockAlign, true)
  fmtView.setUint16(14, bitsPerSample, true)
  if (format === 'extensible') {
    fmtView.setUint16(16, 22, true)
    fmtView.setUint16(18, options.validBitsPerSample ?? bitsPerSample, true)
    fmtView.setUint32(20, options.channelMask ?? 0, true)
    fmt.set([
      0x01, 0x00, 0x00, 0x00,
      0x00, 0x00,
      0x10, 0x00,
      0x80, 0x00,
      0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
    ], 24)
  }
  const sampleBytes = new Uint8Array(dataBytes)
  for (let index = 0; index < sampleBytes.byteLength; index += 1) {
    sampleBytes[index] = (index * 17 + 3) & 0xff
  }
  const chunks = [
    ...(options.junkBeforeFormat ? [chunk('JUNK', new Uint8Array([1, 2, 3, 4, 5]))] : []),
    chunk('fmt ', fmt),
    ...(options.listBeforeData ? [chunk('LIST', new Uint8Array([0x49, 0x4e, 0x46, 0x4f, 0]))] : []),
    chunk('data', sampleBytes),
  ]
  const output = new Uint8Array(12 + chunks.reduce((sum, value) => sum + value.byteLength, 0))
  writeAscii(output, 0, 'RIFF')
  new DataView(output.buffer).setUint32(4, output.byteLength - 8, true)
  writeAscii(output, 8, 'WAVE')
  let offset = 12
  for (const value of chunks) {
    output.set(value, offset)
    offset += value.byteLength
  }
  return output
}
