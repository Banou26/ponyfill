/**
 * The File System Access pickers, with the same names and one behaviour picked.
 *
 * ## The divergence
 *
 * `showSaveFilePicker` exists on the window in Chromium whether or not it can actually be used, and
 * refuses at CALL time in two cases that a property probe cannot see:
 *
 *  - a cross origin ancestor frame, which fails with "Cross origin sub frames aren't allowed to show
 *    a file picker"
 *  - no transient activation, which fails with "Must be handling a user gesture to show a file picker"
 *
 * Firefox does not expose it at all, so `'showSaveFilePicker' in window` answers a different question
 * on each engine: on one it means "might work", on the other "will never work".
 *
 * ## The pick
 *
 * REJECT BEFORE THE ACTIVATION IS SPENT, with a rejection a caller can tell apart from a cancel.
 *
 * That ordering is the whole of it. A caller with a fallback chain has one transient activation to
 * spend, and a picker that rejects at call time has already consumed part of it, so the fallback the
 * caller reaches for next can fail too. Rejecting before the call keeps the gesture intact.
 *
 * `NotAllowedError` for both refusals rather than `AbortError`, because `AbortError` is what the
 * platform throws when the PERSON cancels, and a caller that cannot tell those apart shows an error
 * for something the person chose to do. Ripple's `isSaveCancelled` matches on `AbortError`, so this
 * distinction is load bearing rather than tidy.
 *
 * WHAT IS NOT ABSORBED, deliberately. The fallback chain itself stays with the caller: an anchor
 * download, a service worker sink, or holding bytes in memory are not platform names and choosing
 * between them is a product decision about what a page does when it cannot save. A ponyfill that
 * silently downloaded something instead of opening a picker would be lying about which API it is.
 */

type SaveFilePickerOptions = {
  suggestedName?: string
  types?: { description?: string, accept: Record<string, string[]> }[]
  excludeAcceptAllOption?: boolean
  id?: string
  startIn?: unknown
}

type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>

/**
 * Whether this document is framed by another origin.
 *
 * Chromium exposes the picker either way and refuses it at call time, so a property probe says
 * nothing. A same origin ancestor answers `location.origin`; a cross origin one throws, and so does
 * an opaque origin, which is the case a sandboxed frame presents.
 */
const framedByAnotherOrigin = (): boolean => {
  if (typeof window === 'undefined') return false
  const top = window.top
  if (!top || top === window.self) return false
  try {
    void top.location.origin
    return false
  } catch {
    return true
  }
}

export const showSaveFilePicker: SaveFilePicker = async (options) => {
  const picker = (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
  /*
   * Both refusals are raised HERE, before the call, and that is the point of the wrapper.
   *
   * `NotAllowedError` and never `AbortError`: the platform uses `AbortError` for the person
   * cancelling, and a caller that cannot tell a refusal from a cancel reports a failure for
   * something somebody chose.
   */
  if (!picker) {
    throw new DOMException('this browser has no file save picker', 'NotAllowedError')
  }
  if (framedByAnotherOrigin()) {
    throw new DOMException('a cross origin frame cannot show a file save picker', 'NotAllowedError')
  }
  return picker(options)
}
