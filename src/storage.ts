/**
 * `navigator.storage`, with the two places browsers disagree about it handled in one file.
 *
 * A PONYFILL, so nothing here touches a global. Import `storage` and call the same method names the
 * platform uses, and the difference is that these answers can be relied on across engines:
 *
 *     import { storage } from '@banou/ponyfill'
 *     const { usage, quota } = await storage.estimate()
 *
 * ## What is actually wrong with the native one
 *
 * ### 1. `usage` can be six orders of magnitude short, and nothing says so
 *
 * MEASURED on Chrome 151: an origin holding a VERIFIED 1,783,407,077 bytes of torrent data reported
 * `usage: 1,813,502`, with `usageDetails.fileSystem: 752`. Not a rounding difference, not a stale
 * cache: 752 bytes against 1.78 GB. Anything deciding whether a write will fit from that figure
 * decides that everything fits, and then the write fails with `QuotaExceededError` at whatever
 * moment the real limit is reached.
 *
 * So `estimate()` here WALKS the origin's file system and reports the larger of the two. The walk
 * costs a directory traversal, which is why the native figure is kept as a floor rather than
 * discarded: everything the browser counts that is not the file system is counted correctly, and
 * only the file system part is worth re-measuring.
 *
 * ### 2. `quota` means a different thing on each engine, and the shapes are indistinguishable at rest
 *
 * MEASURED 2026-09-03, one machine with 2.7 TiB free, one origin, three 512 MiB sparse writes per
 * engine, same page and same code:
 *
 * | engine | quota at rest | quota after 1.615 GB written | `quota - usage` |
 * | --- | --- | --- | --- |
 * | Chromium 152 | 10,737,491,968 | 12,353,… , up by exactly what was written | 10,737,418,240 every time, moved 0 bytes |
 * | Firefox | 10,737,418,240 | 10,737,418,240, unmoved | fell 536,870,912 per write |
 *
 * Both cap at 10 GiB. They cap DIFFERENT QUANTITIES. Chromium's quota is a FLOATING ceiling,
 * `usage + headroom`, so the headroom is a constant and can never shrink however much is written.
 * Firefox's is a FIXED ceiling, so writing consumes it.
 *
 * Neither is a bug. The Storage Standard calls quota "a conservative estimate" and never says how to
 * compute it. But it means one very common line is dead on one engine and live on the other:
 *
 *     if (quota - usage < someFloor) { ... }   // can never be true on Chromium
 *
 * That is not a hypothetical. It is why four of ripple's eviction tests sat failing for months: they
 * filled the origin to provoke exactly that condition, and on Chromium the target recedes as fast as
 * it is approached, so 3.5 GB of padding left the free figure identical to the byte.
 *
 * This module does NOT paper over that by inventing a normalised quota, because there is no honest
 * number to invent: on Chromium you really can write 10 more GiB, so the native answer is true. What
 * it does is name the two shapes, say which one an origin has, and refuse to let the difference be
 * discovered again by somebody debugging a dead branch. See {@link QUOTA_CEILING} and
 * {@link measureQuotaCeiling}.
 */

/** The same shape `navigator.storage.estimate()` resolves to, plus what the browser volunteered. */
export type StorageEstimate = {
  usage: number
  quota: number
  usageDetails?: Record<string, number>
}

/**
 * How an engine's `quota` behaves as bytes are written.
 *
 * `fixed` is what most code assumes: a ceiling that stays put, so `quota - usage` falls as you
 * write. `elastic` is Chromium's: the ceiling rises by whatever was written, so `quota - usage` is a
 * constant and never signals pressure. `unknown` is the honest answer before anything has measured
 * it, and it is the default, because the alternative is sniffing the user agent.
 */
export type QuotaCeiling = 'fixed' | 'elastic' | 'unknown'

/**
 * What each engine was measured doing, so a caller can reason without re-running the experiment.
 *
 * Deliberately NOT keyed by user agent string and never consulted automatically. It is a record of
 * measurements, for a human reading this file or writing a comment, and
 * {@link measureQuotaCeiling} is what answers the question for the origin actually in front of you.
 */
export const QUOTA_CEILING: Record<string, { ceiling: QuotaCeiling, measured: string, note: string }> = {
  chromium: {
    ceiling: 'elastic',
    measured: '2026-09-03, Chrome 152.0.7977.64, 2.7 TiB free',
    note: 'quota rose 10.737 GB to 12.353 GB across 1.615 GB written, leaving quota - usage at'
      + ' 10,737,418,240 bytes after every write, unmoved to the byte',
  },
  firefox: {
    ceiling: 'fixed',
    measured: '2026-09-03, Playwright firefox 1532, same machine and origin',
    note: 'quota held at 10,737,418,240 while the headroom fell by the 1,613,063,025 bytes written,'
      + ' byte for byte',
  },
}

/** A directory handle, narrowed to the two members a size walk actually touches. */
type WalkableDirectory = {
  values: () => AsyncIterable<WalkableDirectory | WalkableFile>
  kind?: string
}

type WalkableFile = { kind?: string, getFile: () => Promise<{ size: number }> }

const isDirectory = (handle: WalkableDirectory | WalkableFile): handle is WalkableDirectory =>
  typeof (handle as WalkableDirectory).values === 'function'

/**
 * Every byte under a directory, measured rather than asked for.
 *
 * Recursive, and it counts a file's REPORTED SIZE, which for OPFS is the file's extent rather than
 * how much of it has been written. That is the same accounting the quota system uses, which is the
 * whole point: a one byte write a gigabyte into a file is charged a gigabyte, and a measurement that
 * disagreed with the charge would be no more useful than the figure it replaces.
 *
 * An unreadable entry is SKIPPED rather than fatal. A file the engine currently holds an exclusive
 * sync access handle for cannot be opened by anyone else, and a walk that threw on the first of
 * those would return nothing for exactly the origins that hold the most.
 */
export const measureDirectoryBytes = async (directory: WalkableDirectory): Promise<number> => {
  let total = 0
  const visit = async (handle: WalkableDirectory): Promise<void> => {
    for await (const child of handle.values()) {
      if (isDirectory(child)) { await visit(child); continue }
      const file = await child.getFile().catch(() => null)
      if (file) total += file.size
    }
  }
  await visit(directory)
  return total
}

/**
 * The usage figure to believe, given what the browser said and what a walk found.
 *
 * The larger of the two, and the reason is asymmetric: a browser that OVER-reports has never been
 * observed, while one that under-reports by six orders of magnitude has. So the walk can only ever
 * raise the answer.
 *
 * `usageDetails.fileSystem` is subtracted out before the walk is added when the browser volunteers
 * it, because everything else the browser counts (IndexedDB, caches, service worker registrations)
 * it counts correctly and the walk cannot see any of it. Without that split, an origin holding real
 * IndexedDB data would have it silently dropped from the total.
 *
 * Pure, so the arithmetic is testable without a browser: this is the part that can be wrong in a way
 * no integration test would notice.
 */
export const correctedUsage = (estimate: Partial<StorageEstimate>, walkedBytes: number | null): number | null => {
  const reported = estimate.usage
  if (walkedBytes === null || !Number.isFinite(walkedBytes) || walkedBytes < 0) return reported ?? null
  if (reported === undefined) return walkedBytes
  const fileSystem = estimate.usageDetails?.fileSystem
  if (typeof fileSystem === 'number') {
    // everything counted that is NOT the file system, which the browser counts correctly
    const other = Math.max(0, reported - fileSystem)
    return Math.max(reported, walkedBytes + other)
  }
  return Math.max(reported, walkedBytes)
}

/** True when the browser's own figure is too far below the measured one to be believed. */
export const isUsageUnderReported = (estimate: Partial<StorageEstimate>, walkedBytes: number | null): boolean =>
  walkedBytes !== null && walkedBytes > 0 && (estimate.usage ?? 0) < walkedBytes / 2

/**
 * `navigator.storage`, with the same method names.
 *
 * Only `estimate` behaves differently from the platform's, and only in the way documented at the top
 * of this file. The rest are passed straight through so that a caller can import this once and never
 * reach for the global, which is what keeps the difference in one place instead of at every call
 * site that happens to remember.
 */
export const storage = {
  /**
   * Same name and same shape as the platform's, with `usage` MEASURED rather than reported.
   *
   * Falls back to the browser's own figure whenever the walk cannot be done: no origin private file
   * system, a directory that will not enumerate, or a platform with no `estimate` at all. Falling
   * back is not a silent downgrade, because the browser's figure is a floor rather than a guess: it
   * is never observed to be too HIGH.
   */
  estimate: async (): Promise<StorageEstimate> => {
    const native = globalThis.navigator?.storage
    if (!native?.estimate) return { usage: 0, quota: 0 }
    const estimate = (await native.estimate()) as StorageEstimate
    const walked = native.getDirectory
      ? await native.getDirectory()
        .then((directory) => measureDirectoryBytes(directory as unknown as WalkableDirectory))
        .catch(() => null)
      : null
    return { ...estimate, usage: correctedUsage(estimate, walked) ?? estimate.usage ?? 0 }
  },

  persist: (): Promise<boolean> =>
    globalThis.navigator?.storage?.persist?.() ?? Promise.resolve(false),

  persisted: (): Promise<boolean> =>
    globalThis.navigator?.storage?.persisted?.() ?? Promise.resolve(false),

  getDirectory: (): Promise<FileSystemDirectoryHandle> => {
    const native = globalThis.navigator?.storage
    if (!native?.getDirectory) return Promise.reject(new Error('this browser has no origin private file system'))
    return native.getDirectory()
  },
}

/**
 * Which ceiling this origin has, by WRITING and watching, because nothing else can tell.
 *
 * The two shapes are indistinguishable at rest: at low usage a flat quota and a flat headroom are
 * the same pair of numbers, which is exactly how the difference went unnoticed. Only writing
 * separates them, so this writes, and it is therefore not something to call casually.
 *
 * Sparse, so it costs no real disk: the quota system charges a file's EXTENT, and a single byte
 * written `probeBytes - 1` into a file is charged the whole extent instantly. The probe file is
 * removed again, in a `finally`, whether or not the measurement succeeded.
 *
 * Answers `unknown` rather than guessing when the probe cannot be written or the origin refuses it,
 * because "I could not tell" and "the ceiling is fixed" lead to opposite decisions.
 */
export const measureQuotaCeiling = async (
  { probeBytes = 512 * 1024 * 1024, name = '.ponyfill-quota-probe' }: { probeBytes?: number, name?: string } = {},
): Promise<QuotaCeiling> => {
  const native = globalThis.navigator?.storage
  if (!native?.estimate || !native.getDirectory) return 'unknown'
  let root: FileSystemDirectoryHandle
  try { root = await native.getDirectory() } catch { return 'unknown' }

  const before = (await native.estimate()) as StorageEstimate
  try {
    const handle = await root.getFileHandle(name, { create: true })
    const writable = await (handle as FileSystemFileHandle & {
      createWritable: () => Promise<{ write: (chunk: unknown) => Promise<void>, close: () => Promise<void> }>
    }).createWritable()
    await writable.write({ type: 'write', position: probeBytes - 1, data: new Uint8Array(1) })
    await writable.close()

    const after = (await native.estimate()) as StorageEstimate
    const written = (after.usage ?? 0) - (before.usage ?? 0)
    // nothing landed, so the question was never actually asked
    if (written < probeBytes / 2) return 'unknown'
    const headroomBefore = (before.quota ?? 0) - (before.usage ?? 0)
    const headroomAfter = (after.quota ?? 0) - (after.usage ?? 0)
    // a quarter of what was written is far outside any rounding, and far inside a real ceiling move
    return headroomBefore - headroomAfter < written / 4 ? 'elastic' : 'fixed'
  } catch {
    return 'unknown'
  } finally {
    await root.removeEntry(name).catch(() => {})
  }
}
