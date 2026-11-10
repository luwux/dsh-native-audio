import { Buffer } from 'node:buffer'
import { AudioAttachmentError } from './error.js'
import type { AudioAttachmentStore } from './service.js'
import type { AudioAttachmentRef, EncodedAudioAttachment, SaveAudioAttachment } from './types.js'

function decodeBase64(data: string): Uint8Array {
  const decoded = Buffer.from(data, 'base64')
  if (data.length === 0 || decoded.toString('base64') !== data) {
    throw new AudioAttachmentError('Audio upload is not canonical base64.', 'INVALID_AUDIO_BASE64')
  }
  return new Uint8Array(decoded)
}
function saveInput(audio: EncodedAudioAttachment): SaveAudioAttachment {
  return {
    data: decodeBase64(audio.data),
    mediaType: audio.mediaType,
    ...(audio.name === undefined ? {} : { name: audio.name }),
  }
}

/** Admit one ordered wire batch and return durable references in the same order. */
export async function admitEncodedAudios(
  attachments: AudioAttachmentStore,
  audios: readonly EncodedAudioAttachment[],
): Promise<readonly AudioAttachmentRef[]> {
  return attachments.saveAudios(audios.map(saveInput))
}
