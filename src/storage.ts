/**
 * `navigator.storage`, with the same method names and no extra ones.
 *
 * A PONYFILL, so nothing here touches a global and nothing here invents API. You import `storage`
 * and call it exactly as you would the platform's:
 *
 *     import { storage } from '@banou/ponyfill'
 *     const { usage, quota } = await storage.estimate()
 *
 * Only `estimate` behaves differently from the platform's, and only by being CORRECT. The rest are
 * passed straight through so this can be a drop-in for `navigator.storage`, which is the whole point:
 * a caller that had to mix `storage.estimate()` with `navigator.storage.getDirectory()` would be
 * back to remembering which half is safe.
 *
 * ## Why `estimate` cannot be believed as the platform gives it
 *
 * ### `usage` can be six orders of magnitude short
 *
 * MEASURED on Chrome 151: an origin holding a VERIFIED 1,783,407,077 bytes of torrent data reported
 *
 *     usage: 1813502
 *     usageDetails: { fileSystem: 752, indexedDB: 1809581, serviceWorkerRegistrations: 3169 }
 *
 * 752 bytes against 1.78 GB. Not rounding and not lag, and not universal either: another machine
 * reported the same data correctly, so the figure can neither be trusted nor discarded.
 *
 * So `estimate()` WALKS the origin's file system and reports whichever answer is larger. Larger is
 * the safe direction on purpose. Over-reporting makes a caller reclaim cache slightly early, which
 * is what cache is for; under-reporting makes it decide there is room forever, and what happens then
 * is not a full disk, it is a write failing with `QuotaExceededError` at some unrelated moment.
 *
 * Where `usageDetails` is available the correction is surgical: the file system component is the
 * broken one, so it is replaced with the measurement and the components the browser counts correctly
 * are kept. Without it, the larger of the two is the best available answer.
 *
 * ### `quota` means a different thing on each engine
 *
 * MEASURED 2026-09-03, one machine with 2.7 TiB free, one origin, three 512 MiB sparse writes per
 * engine, same page and same code:
 *
 * | engine | quota at rest | after 1.615 GB written | `quota - usage` |
 * | --- | --- | --- | --- |
 * | Chromium 152 | 10,737,491,968 | rose by exactly what was written | 10,737,418,240 every time, moved 0 bytes |
 * | Firefox | 10,737,418,240 | unmoved | fell 536,870,912 per write |
 *
 * Both cap at 10 GiB. They cap DIFFERENT QUANTITIES. Chromium's quota is a FLOATING ceiling,
 * `usage + headroom`, so the headroom is a constant and can never shrink however much is written.
 * Firefox's is a FIXED ceiling, so writing consumes it.
 *
 * Neither is a bug: the Storage Standard calls quota "a conservative estimate" and never says how to
 * compute it. But it means one very common line is dead on one engine and live on the other:
 *
 *     if (quota - usage < someFloor) { ... }   // can never be true on Chromium
 *
 * Nothing here papers over that, because there is no honest number to substitute: on Chromium you
 * really can write 10 more GiB, so the platform's answer is true. It is written down here because
 * the two shapes are indistinguishable at rest, which is how the difference went unnoticed long
 * enough to leave four of ripple's storage tests failing for months against a condition that could
 * never occur.
 */

/**
 * The platform's own `StorageEstimate`, named the same.
 *
 * Every field optional exactly as the specification has them, so this is a drop-in for what
 * `navigator.storage.estimate()` resolves to rather than a stricter thing a caller has to adapt to.
 */
export type StorageEstimate = {
  usage?: number
  quota?: number
  /** Chrome only, and the whole reason the correction can be surgical rather than merely larger. */
  usageDetails?: { fileSystem?: number }
}

/**
 * Never walk forever: a cycle is impossible in the origin private file system, but a pathological
 * tree is not, and neither is a directory with a hundred thousand entries in it.
 *
 * Bounds rather than correctness. Hitting either returns what was counted so far instead of failing,
 * which keeps the answer a floor in the same direction as everything else here.
 */
const MAX_DEPTH = 8
const MAX_ENTRIES = 20_000

/** A directory handle, narrowed to the two members a size walk actually touches. */
type WalkableDirectory = {
  values: () => AsyncIterable<WalkableDirectory | WalkableFile>
}

type WalkableFile = { getFile: () => Promise<{ size: number }> }

const isDirectory = (handle: WalkableDirectory | WalkableFile): handle is WalkableDirectory =>
  typeof (handle as WalkableDirectory).values === 'function'

/**
 * Every byte under a directory, or `null` when the walk could not be done at all.
 *
 * The null is a distinct third answer and the correction below depends on it: "the origin holds
 * nothing" and "the file system was unreachable" lead to opposite decisions, and collapsing them to
 * 0 would report an empty origin for one that simply could not be read.
 *
 * Counts a file's REPORTED SIZE, which for this file system is its extent rather than how much of it
 * has been written. That is the same accounting the quota system uses, which is the point: a one byte
 * write a gigabyte into a file is charged a gigabyte, and a measurement that disagreed with the
 * charge would be no more useful than the figure it replaces.
 *
 * An unreadable ENTRY is skipped rather than fatal. A file something else currently holds an
 * exclusive sync access handle for cannot be opened, and `getFile()` on it throws rather than
 * waiting, so a walk that gave up on the first of those would return nothing for exactly the origins
 * holding the most. The answer is therefore a floor: short by the files open right now, never long.
 */
const walkBytes = async (directory: WalkableDirectory): Promise<number | null> => {
  let total = 0
  let seen = 0
  const visit = async (handle: WalkableDirectory, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return
    for await (const child of handle.values()) {
      if (++seen > MAX_ENTRIES) return
      if (isDirectory(child)) { await visit(child, depth + 1); continue }
      // locked by a live sync access handle, or removed between listing and reading: both are
      // ordinary, and both mean this file cannot be counted rather than that the walk failed
      const file = await child.getFile().catch(() => null)
      if (file) total += file.size
    }
  }
  try {
    await visit(directory, 0)
    return total
  } catch {
    // the whole file system was unreachable, which is a different thing from a file being busy
    return null
  }
}

/**
 * The usage to report, given what the platform said and what the walk found.
 *
 * The walk can only ever RAISE the answer: a browser over-reporting has never been observed, while
 * one under-reporting by six orders of magnitude has.
 */
const reconcile = (estimate: StorageEstimate, walked: number | null): number | undefined => {
  const reported = estimate.usage
  if (walked === null || !Number.isFinite(walked) || walked < 0) return reported
  if (reported === undefined) return walked
  const fileSystem = estimate.usageDetails?.fileSystem
  if (typeof fileSystem === 'number') {
    // everything counted that is NOT the file system, which the browser counts correctly
    const other = Math.max(0, reported - fileSystem)
    return Math.max(reported, walked + other)
  }
  return Math.max(reported, walked)
}

/**
 * The narrowest quota this origin has reported, which is the one that gets reported back.
 *
 * THE DIVERGENCE, AND THE PICK. `quota - usage` already means the same on both engines: bytes you
 * can still write. What diverges is `quota` as a TOTAL, and Chromium never states one. It states
 * `usage + headroom`, recomputed on every read, so the number grows as you fill the origin: measured
 * 10.737 GB rising to 12.353 GB across 1.615 GB written. Firefox states a real total and holds it.
 *
 * Two things a caller does with `quota` are broken by the growing version and neither is exotic:
 *
 *  - `usage / quota` as a gauge never fills, because the denominator runs away from the numerator.
 *    Ripple showed "2 MB / 10.74 GB" over a library holding 1.78 GB for exactly this reason.
 *  - `quota - usage < floor` never fires, so nothing can ever detect pressure. That is what left four
 *    of ripple's eviction tests failing for months against a condition that could not occur.
 *
 * So the behaviour picked here is FIREFOX'S: a ceiling, and a ceiling does not rise because you put
 * something under it. It is implemented as the lowest quota seen for this origin, which needs no
 * probe and no user agent sniffing, and it is TRUE in the strong sense: the platform really did say
 * the origin could hold this much, and nothing here invents a number the platform never stated.
 *
 * The cost is deliberate and is in the safe direction. On Chromium, once some bytes are written, the
 * reported headroom is smaller than what could really be written, so a caller reclaims cache
 * slightly early. Cache is the thing that can be fetched again; a caller that never reclaims because
 * it never sees pressure is the failure this replaces.
 *
 * In memory, and per REALM rather than per page: a worker holds its own. Persisting it would mean
 * owning storage to describe storage, and a reload re-anchors on a figure the platform stated at
 * that moment, which is the same guarantee. What a realm cannot be allowed to do is hold a ceiling
 * that has since moved, and the release below is how it lets go without any realm telling another.
 */
let narrowest: number | undefined

/**
 * Whether the origin was persistent when the ceiling above was latched.
 *
 * THE LATCH HAS TO BE ABLE TO LET GO, AND IN A REALM THAT NEVER ASKED. A grant moves the ceiling by
 * orders of magnitude (measured 2026-09-01 on Firefox: 12 GB to 3.97 TB), so the figure learned
 * before it is worse than useless afterwards. `persist()` is a MAIN THREAD call, because a worker's
 * StorageManager has none, so a worker that latched 12 GB would hold it for its whole life while the
 * page moved on. Anything deciding what to delete from that figure would go on deleting against a
 * ceiling that no longer exists.
 *
 * So the release is keyed on the STATE rather than on the call: every `estimate()` reads
 * `persisted()` alongside the quota, and a change since the latch drops it. That works in every
 * realm, including the ones that could not have made the call, and it needs no shared state between
 * them. `undefined` means the engine would not say, and an engine that will not say has not reported
 * a change, so the latch stands.
 */
let latchedUnder: boolean | undefined

const ceiling = (
  reported: number | undefined,
  usage: number | undefined,
  persistent: boolean | undefined,
): number | undefined => {
  if (reported === undefined) return undefined
  // the state moved, so the ceiling that was latched under it moved with it
  if (persistent !== latchedUnder) narrowest = undefined
  latchedUnder = persistent
  narrowest = narrowest === undefined ? reported : Math.min(narrowest, reported)
  // never below what is already stored, or `quota - usage` goes negative and every caller's
  // arithmetic goes with it. At worst the headroom reads zero, which is the honest answer for an
  // origin holding more than the ceiling it was first offered.
  return Math.max(narrowest, usage ?? 0)
}

/**
 * Whether this origin is persistent, or undefined where the engine has no way to be asked.
 *
 * A REJECTION IS NOT A CHANGE OF STATE, so it answers whatever the ceiling was latched under and the
 * latch is left alone. Treating a failed read as a third value would make an engine that fails this
 * call intermittently drop the ceiling every other estimate, which is the pick quietly turning
 * itself off on exactly the engines least able to spare it.
 */
const persistence = async (native: StorageManager): Promise<boolean | undefined> =>
  native.persisted
    ? native.persisted().then((value) => value === true).catch(() => latchedUnder)
    : undefined

export const storage = {
  /**
   * Same name and same shape as the platform's, with `usage` MEASURED rather than reported.
   *
   * Falls back to the platform's own figure whenever the walk cannot be done: no origin private file
   * system, a directory that will not enumerate, or no `estimate` at all. That is not a silent
   * downgrade, because the platform's figure is a floor rather than a guess.
   */
  estimate: async (): Promise<StorageEstimate> => {
    const native = globalThis.navigator?.storage
    if (!native?.estimate) return {}
    const estimate = (await native.estimate()) as StorageEstimate
    const [walked, persistent] = await Promise.all([
      native.getDirectory
        ? native.getDirectory()
          .then((directory) => walkBytes(directory as unknown as WalkableDirectory))
          .catch(() => null)
        : null,
      persistence(native),
    ])
    const usage = reconcile(estimate, walked)
    return { ...estimate, usage, quota: ceiling(estimate.quota, usage, persistent) }
  },

  /**
   * Same name and signature, resolving what the origin IS rather than what the call said it did.
   *
   * TWO PICKS, both inside one call.
   *
   * FIRST, the answer. `persist()` resolves its own claim, and `persisted()` resolves the state the
   * app then lives in. Those are different questions and only the second decides anything: whether
   * the origin can still be evicted. A call can resolve false on an engine where the origin is
   * already persistent, and an app reading the first answer then offers a button that has nothing
   * left to do. So this resolves `persisted()`, falling back to the call's own answer only where the
   * platform will not state the state.
   *
   * SECOND, the ceiling, which this call does NOT release and deliberately so. A granted persist can
   * move the quota by orders of magnitude: measured 2026-09-01 on Firefox, granting the "Store data
   * in persistent storage" doorhanger moved the reported quota from 12 GB to 3.97 TB on an 8.03 TB
   * device, about 330 times. `estimate()` latches the narrowest quota it has seen, which is right
   * while nothing changes the ceiling and wrong the moment something does.
   *
   * Releasing it HERE would only release it in the realm that made the call, and this call can only
   * be made from the main thread. So the release lives in `estimate()`, keyed on the persistence
   * state rather than on the call, and every realm picks the change up on its next read. See
   * `latchedUnder`.
   *
   * Chromium, measured 2026-08-30 on Chrome 151, refuses this on every attempt with no prompt shown
   * at any point, and the quota stays flat. That is not a failure to handle: it is the engine
   * answering, and `persisted()` reports the same false afterwards.
   */
  persist: async (): Promise<boolean> => {
    const native = globalThis.navigator?.storage
    if (!native?.persist) return false
    const answered = await native.persist().catch(() => false)
    const state = await persistence(native) ?? null
    // the ceiling is released by `estimate()` comparing this state against the one it latched under,
    // rather than here, so a realm that cannot make this call is not stuck with a stale figure
    return state ?? answered
  },

  persisted: (): Promise<boolean> =>
    globalThis.navigator?.storage?.persisted?.() ?? Promise.resolve(false),

  getDirectory: (): Promise<FileSystemDirectoryHandle> => {
    const native = globalThis.navigator?.storage
    if (!native?.getDirectory) return Promise.reject(new Error('this browser has no origin private file system'))
    return native.getDirectory()
  },
}
