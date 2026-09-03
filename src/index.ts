/**
 * Ponyfills for the places browsers disagree, so an app never carries the difference itself.
 *
 * A PONYFILL and not a polyfill: nothing here is written to a global, ever. You import the wrapped
 * API and call it exactly as you would the platform's, with the same names:
 *
 *     import { storage } from '@banou/ponyfill'
 *     const { usage, quota } = await storage.estimate()
 *
 * That constraint is the whole design. A polyfill that patched `navigator.storage` would change what
 * every other script on the page sees, including code that was correct against the real behaviour,
 * and it would make the difference invisible at the call site. An import is greppable, and a package
 * boundary is somewhere the measurement that justifies each workaround can live next to the code.
 *
 * ## What belongs in here
 *
 * Anything that behaves differently between engines, or differently from its own specification, and
 * that an app would otherwise work around in place. The rule is not "hard to implement", it is
 * "surprising": if finding it out cost a measurement, the measurement belongs beside the fix so the
 * next person is not made to repeat it.
 *
 * Every module here states what was measured, on what, and when. A workaround with no measurement
 * behind it is a guess that outlives the bug it was written for.
 */

export {
  QUOTA_CEILING,
  correctedUsage,
  isUsageUnderReported,
  measureDirectoryBytes,
  measureQuotaCeiling,
  storage,
} from './storage'

export type { QuotaCeiling, StorageEstimate } from './storage'
