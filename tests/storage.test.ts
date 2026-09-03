import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  QUOTA_CEILING,
  correctedUsage,
  isUsageUnderReported,
  measureDirectoryBytes,
  measureQuotaCeiling,
  storage,
} from '../src/storage'

/**
 * The numbers here are MEASURED, not invented, and that is what makes them worth pinning.
 *
 * `REPORTED` is what Chrome 151 actually said about an origin holding `ON_DISK` bytes of verified
 * torrent data. A reader who thinks the gap looks like a typo should read it again: 752 bytes of
 * `usageDetails.fileSystem` against 1.78 GB on disk, six orders of magnitude.
 */
const REPORTED = {
  usage: 1_813_502,
  quota: 10_739_231_742,
  usageDetails: { fileSystem: 752, indexedDB: 1_809_581, serviceWorkerRegistrations: 3_169 },
}
const ON_DISK = 1_783_407_077

type FakeHandle = { kind: 'file' | 'directory' }

const file = (size: number, name = 'f'): FakeHandle =>
  ({ kind: 'file', name, getFile: async () => ({ size }) } as FakeHandle)

const dir = (children: FakeHandle[]): FakeHandle =>
  ({ kind: 'directory', values: async function * () { for (const child of children) yield child } } as FakeHandle)

const stubStorage = (over: Record<string, unknown>) => {
  vi.stubGlobal('navigator', { storage: over })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('measuring what is actually on the origin', () => {
  it('adds up a nested tree', async () => {
    expect(await measureDirectoryBytes(dir([
      file(10),
      dir([file(100), dir([file(1_000)])]),
      file(10_000),
    ]) as never)).toBe(11_110)
  })

  it('is zero for an empty origin rather than throwing', async () => {
    expect(await measureDirectoryBytes(dir([]) as never)).toBe(0)
  })

  /**
   * A file the engine holds an exclusive sync access handle for cannot be opened by anyone else, and
   * an origin under a running torrent client is full of them. A walk that threw on the first would
   * report nothing for exactly the origins holding the most.
   */
  it('skips an entry it cannot open instead of abandoning the walk', async () => {
    const locked = { kind: 'file', getFile: async () => { throw new Error('NoModificationAllowedError') } } as FakeHandle
    expect(await measureDirectoryBytes(dir([file(500), locked, file(300)]) as never)).toBe(800)
  })

  /**
   * NULL is a third answer and callers depend on it.
   *
   * "the origin holds nothing" and "the file system could not be read" lead to opposite decisions:
   * the first says there is room, the second says nothing at all. Collapsing them to 0 would have
   * `correctedUsage` report an empty origin for one that simply could not be enumerated, which is
   * the under-report this whole module exists to defend against, arrived at from the other side.
   */
  it('answers null when the whole walk fails, which is not the same as zero', async () => {
    const unreadable = { kind: 'directory', values: () => { throw new Error('nope') } } as unknown as FakeHandle
    expect(await measureDirectoryBytes(unreadable as never)).toBeNull()
    expect(await measureDirectoryBytes(dir([]) as never), 'an empty origin still answers zero').toBe(0)
  })

  /**
   * The two bounds, which are about not hanging rather than about being right.
   *
   * A cycle is impossible in OPFS, but a pathological tree is not, and neither is a directory with
   * a hundred thousand entries. Hitting either bound returns what was counted so far rather than
   * failing, so the answer stays a floor in the same direction as everything else here.
   */
  it('stops descending past the depth bound', async () => {
    const deep = (levels: number): FakeHandle =>
      levels === 0 ? dir([file(1_000)]) : dir([file(1), deep(levels - 1)])
    // every level contributes 1 byte, plus 1000 at the bottom if it is ever reached
    expect(await measureDirectoryBytes(deep(3) as never, { maxDepth: 8 })).toBe(1_003)
    expect(await measureDirectoryBytes(deep(20) as never, { maxDepth: 2 }), 'the floor stops early').toBe(3)
  })

  it('stops counting past the entry bound', async () => {
    const many = dir(Array.from({ length: 50 }, (_, i) => file(10, `f${i}`)))
    expect(await measureDirectoryBytes(many as never, { maxEntries: 5 })).toBe(50)
    expect(await measureDirectoryBytes(many as never), 'unbounded by default reaches them all').toBe(500)
  })
})

describe('which usage figure to believe', () => {
  /**
   * THE CASE THIS PACKAGE EXISTS FOR.
   *
   * The browser's own answer is 1.8 MB. The truth is 1.78 GB. Anything sizing a write from the first
   * number decides that everything fits.
   */
  it('prefers a walk that is six orders of magnitude above the browser figure', () => {
    expect(correctedUsage(REPORTED, ON_DISK)).toBeGreaterThan(ON_DISK)
    // the control: believing the browser is off by three orders of magnitude
    expect(REPORTED.usage).toBeLessThan(ON_DISK / 900)
  })

  /**
   * The split matters as much as the maximum. IndexedDB and service worker registrations are counted
   * correctly by the browser and are invisible to a file system walk, so they have to be carried
   * across rather than replaced. Dropping them would UNDER-count an origin holding real IndexedDB
   * data, which is the same class of bug in the other direction.
   */
  it('keeps what the browser counts correctly and replaces only the file system part', () => {
    const other = REPORTED.usage - REPORTED.usageDetails.fileSystem
    expect(correctedUsage(REPORTED, ON_DISK)).toBe(ON_DISK + other)
    expect(other, 'the non file system part is real and must survive').toBeGreaterThan(1_800_000)
  })

  it('replaces the whole figure when the browser volunteers no breakdown', () => {
    expect(correctedUsage({ usage: 752, quota: 1 }, ON_DISK)).toBe(ON_DISK)
  })

  /** The walk can only ever RAISE the answer: a browser over-reporting has never been observed. */
  it('never lowers the browser figure', () => {
    expect(correctedUsage({ usage: 9_000, quota: 1 }, 10)).toBe(9_000)
    expect(correctedUsage(REPORTED, 0)).toBe(REPORTED.usage)
  })

  it('falls back cleanly when there is no walk, and gives up when there is nothing at all', () => {
    expect(correctedUsage(REPORTED, null)).toBe(REPORTED.usage)
    expect(correctedUsage({}, null)).toBeNull()
    expect(correctedUsage({}, 500)).toBe(500)
    expect(correctedUsage(REPORTED, Number.NaN)).toBe(REPORTED.usage)
    expect(correctedUsage(REPORTED, -1)).toBe(REPORTED.usage)
  })

  it('can say the browser is not to be believed, for a caller that wants to warn', () => {
    expect(isUsageUnderReported(REPORTED, ON_DISK)).toBe(true)
    expect(isUsageUnderReported({ usage: ON_DISK }, ON_DISK)).toBe(false)
    expect(isUsageUnderReported(REPORTED, null)).toBe(false)
    expect(isUsageUnderReported(REPORTED, 0)).toBe(false)
  })
})

describe('storage.estimate, which is the platform name for the platform shape', () => {
  it('returns the corrected usage and the browser quota untouched', async () => {
    stubStorage({
      estimate: async () => REPORTED,
      getDirectory: async () => dir([dir([file(ON_DISK - 1_000), file(1_000)])]),
    })
    const estimate = await storage.estimate()
    expect(estimate.quota, 'the quota is the browser\'s to state, and is never rewritten').toBe(REPORTED.quota)
    expect(estimate.usage).toBe(ON_DISK + (REPORTED.usage - REPORTED.usageDetails.fileSystem))
    // the shape is the platform's, so a caller can destructure it exactly as it would the real one
    expect(Object.keys(estimate).sort()).toEqual(['quota', 'usage', 'usageDetails'])
  })

  it('falls back to the browser figure when the origin will not enumerate', async () => {
    stubStorage({
      estimate: async () => REPORTED,
      getDirectory: async () => ({ kind: 'directory', values: () => { throw new Error('nope') } }),
    })
    expect((await storage.estimate()).usage).toBe(REPORTED.usage)
  })

  it('falls back when there is no origin private file system at all', async () => {
    stubStorage({ estimate: async () => REPORTED })
    expect((await storage.estimate()).usage).toBe(REPORTED.usage)
  })

  /** A platform with no Storage API answers zero rather than throwing, so callers need no guard. */
  it('answers zero rather than throwing where the API is absent', async () => {
    vi.stubGlobal('navigator', {})
    expect(await storage.estimate()).toEqual({ usage: 0, quota: 0 })
    expect(await storage.persist()).toBe(false)
    expect(await storage.persisted()).toBe(false)
    await expect(storage.getDirectory()).rejects.toThrow(/origin private file system/)
  })

  it('passes persist and persisted straight through', async () => {
    stubStorage({ persist: async () => true, persisted: async () => true })
    expect(await storage.persist()).toBe(true)
    expect(await storage.persisted()).toBe(true)
  })
})

/**
 * The ceiling probe, driven against fake engines that reproduce each measured behaviour exactly.
 *
 * `elastic` raises the quota by whatever was written, which is Chromium. `fixed` holds it, which is
 * Firefox. Both are fed the same probe, so what is being tested is that the probe can tell them
 * apart, which is the thing that took a browser and three writes to discover the first time.
 */
describe('telling a floating ceiling from a fixed one', () => {
  const PROBE = 512 * 1024 * 1024

  const engine = (ceiling: 'fixed' | 'elastic', { lands = true } = {}) => {
    let usage = 1_000_000
    const startQuota = 10_737_418_240
    const removed: string[] = []
    stubStorage({
      estimate: async () => ({
        usage,
        quota: ceiling === 'elastic' ? startQuota + (usage - 1_000_000) : startQuota,
      }),
      getDirectory: async () => ({
        getFileHandle: async () => ({
          createWritable: async () => ({
            write: async () => { if (lands) usage += PROBE },
            close: async () => {},
          }),
        }),
        removeEntry: async (name: string) => { removed.push(name) },
      }),
    })
    return removed
  }

  it('calls a ceiling that rises by what was written elastic', async () => {
    engine('elastic')
    expect(await measureQuotaCeiling({ probeBytes: PROBE })).toBe('elastic')
  })

  it('calls a ceiling that stays put fixed', async () => {
    engine('fixed')
    expect(await measureQuotaCeiling({ probeBytes: PROBE })).toBe('fixed')
  })

  /** A probe that never landed has not asked the question, and must not answer it either way. */
  it('answers unknown when the write does not land', async () => {
    engine('fixed', { lands: false })
    expect(await measureQuotaCeiling({ probeBytes: PROBE })).toBe('unknown')
  })

  it('answers unknown rather than guessing where there is no storage API', async () => {
    vi.stubGlobal('navigator', {})
    expect(await measureQuotaCeiling()).toBe('unknown')
  })

  it('removes its probe file whichever answer it reaches', async () => {
    const removed = engine('elastic')
    await measureQuotaCeiling({ probeBytes: PROBE, name: '.probe' })
    expect(removed, 'a probe left behind is charged against the origin for good').toEqual(['.probe'])
  })
})

describe('the record of what each engine was measured doing', () => {
  it('names both shapes, because a table with one entry teaches nothing', () => {
    expect(QUOTA_CEILING.chromium!.ceiling).toBe('elastic')
    expect(QUOTA_CEILING.firefox!.ceiling).toBe('fixed')
    for (const entry of Object.values(QUOTA_CEILING)) {
      expect(entry.measured, 'a workaround with no measurement behind it is a guess').toMatch(/\d{4}-\d{2}-\d{2}/)
    }
  })
})
