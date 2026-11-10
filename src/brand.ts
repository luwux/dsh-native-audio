declare const audioAttachmentIdBrand: unique symbol

/** Opaque content-addressed identifier for one immutable audio object. */
export type AudioAttachmentId = string & { readonly [audioAttachmentIdBrand]: true }

/** Brand a storage identifier after the store has validated or created it. */
export function AudioAttachmentId(value: string): AudioAttachmentId {
  return value as AudioAttachmentId
}
