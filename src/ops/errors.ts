/** The file is damaged or isn't what it claims to be. The UI appends a "save a fresh copy" hint. */
export class DecodeError extends Error {
  override name = 'DecodeError'
}

/** A complete, user-facing explanation (e.g. a password-protected PDF). Shown as written. */
export class NoticeError extends Error {
  override name = 'NoticeError'
}
