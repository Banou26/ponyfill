import { afterEach, describe, expect, it, vi } from 'vitest'

import * as pkg from '../src/index'

/**
 * A FRESH MODULE per test, because `quota` is now a ceiling and a ceiling remembers.
 *
 * `storage.estimate()` keeps the narrowest quota it has seen for the origin, which is the whole
 * point of the pick, and that state would otherwise leak from one case into the next. Resetting it
 * through `vi.resetModules()` rather than through an exported hook keeps the surface the platform's:
 * `navigator.storage` has no reset either.
 */
const fresh = async () => {
  vi.resetModules()
  return (await import('../src/storage')).storage
}

/**
 * Everything here goes through `storage.estimate()`, because that is the whole of the public surface
 * and testing anything else would be testing an implementation that is deliberately not exported.
 *
 * The numbers are MEASURED, not invented. `REPORTED` is what Chrome 151 actually said about an origin
 * holding `ON_DISK` bytes of verified torrent data. A reader who thinks the gap looks like a typo
 * should read it again: 752 bytes of `usageDetails.fileSystem` against 1.78 GB on disk.
 */
const REPORTED = {
  usage: 1_813_502,
  quota: 10_739_231_742,
  usageDetails: { fileSystem: 752, indexedDB: 1_809_581, serviceWorkerRegistrations: 3_169 },
}
const ON_DISK = 1_783_407_077
/** What the browser counts correctly and a file system walk cannot see. */
const OTHER = REPORTED.usage - REPORTED.usageDetails.fileSystem

type Handle = { getFile?: () => Promise<{ size: number }>, values?: () => AsyncIterable<Handle> }

const file = (size: number): Handle => ({ getFile: async () => ({ size }) })

const dir = (children: Handle[]): Handle =>
  ({ values: async function * () { for (const child of children) yield child } })

const stub = (over: Record<string, unknown>) => { vi.stubGlobal('navigator', { storage: over }) }

afterEach(() => { vi.unstubAllGlobals() })

/**
 * The constraint that makes this a ponyfill rather than a utility library.
 *
 * An export that is not a platform name is not a ponyfill of anything. `navigator.storage` has four
 * members and this has the same four; the walk that corrects `usage`, its bounds and the
 * reconciliation are all internal because the platform has no such members.
 *
 * This is a real guard rather than a statement of intent: the surface grew to seven exports before
 * anyone noticed, including a `measureQuotaCeiling` that no consumer ever called.
 */
describe('the public surface is the platform surface', () => {
  it('exports nothing the platform does not have', async () => {
    const storage = await fresh()
    expect(Object.keys(pkg).sort()).toEqual(['storage'])
    expect(Object.keys(storage).sort()).toEqual(['estimate', 'getDirectory', 'persist', 'persisted'])
  })

  it('answers the shape the platform answers, with no extra fields', async () => {
    const storage = await fresh()
    stub({ estimate: async () => REPORTED, getDirectory: async () => dir([file(ON_DISK)]) })
    expect(Object.keys(await storage.estimate()).sort()).toEqual(['quota', 'usage', 'usageDetails'])
  })
})

describe('estimate, which is the one that cannot be believed as the platform gives it', () => {
  /**
   * THE CASE THIS PACKAGE EXISTS FOR. The browser's answer is 1.8 MB; the truth is 1.78 GB. Anything
   * sizing a write from the first number decides that everything fits.
   */
  it('reports what is on disk, not the figure that is six orders of magnitude short', async () => {
    const storage = await fresh()
    stub({ estimate: async () => REPORTED, getDirectory: async () => dir([dir([file(ON_DISK)])]) })
    const { usage } = await storage.estimate()
    // the control: the platform's own answer is three orders of magnitude below the truth
    expect(REPORTED.usage).toBeLessThan(ON_DISK / 900)
    expect(usage).toBe(ON_DISK + OTHER)
  })

  /**
   * The split matters as much as the maximum. IndexedDB and service worker registrations are counted
   * correctly and are invisible to a file system walk, so they are carried across rather than
   * replaced. Dropping them under-counts an origin holding real IndexedDB data, which is the same
   * class of bug in the other direction.
   */
  it('keeps what the browser counts correctly and replaces only the file system part', async () => {
    const storage = await fresh()
    stub({ estimate: async () => REPORTED, getDirectory: async () => dir([file(ON_DISK)]) })
    expect((await storage.estimate()).usage).toBe(ON_DISK + OTHER)
    expect(OTHER, 'the non file system part is real and must survive').toBeGreaterThan(1_800_000)
  })

  it('replaces the whole figure when the browser volunteers no breakdown', async () => {
    const storage = await fresh()
    stub({ estimate: async () => ({ usage: 752, quota: 1 }), getDirectory: async () => dir([file(ON_DISK)]) })
    expect((await storage.estimate()).usage).toBe(ON_DISK)
  })

  /** The walk can only ever RAISE the answer: a browser over-reporting has never been observed. */
  it('never lowers the browser figure', async () => {
    const storage = await fresh()
    stub({ estimate: async () => ({ usage: 9_000, quota: 1 }), getDirectory: async () => dir([file(10)]) })
    expect((await storage.estimate()).usage).toBe(9_000)
  })

  it('reports the quota the browser stated, when the browser holds it still', async () => {
    const storage = await fresh()
    stub({ estimate: async () => REPORTED, getDirectory: async () => dir([file(ON_DISK)]) })
    expect((await storage.estimate()).quota).toBe(REPORTED.quota)
  })
})

/**
 * THE SEMANTIC DIVERGENCE, and the behaviour picked for it.
 *
 * `usage` diverges because one engine is WRONG. `quota` diverges because the two are both right and
 * mean different things by the word: Chromium answers `usage + headroom`, recomputed every read, so
 * it rises as the origin fills; Firefox answers a total and holds it.
 *
 * Firefox's is the meaning taken here, because a ceiling that rises when you put something under it
 * is not a ceiling. The numbers below are the measured ones: quota 10.737 GB rising to 12.353 GB
 * across 1.615 GB written, with the headroom pinned at 10,737,418,240 the whole way.
 */
describe('quota is a ceiling, so it does not rise as the origin fills', () => {
  const HEADROOM = 10_737_418_240

  /** Chromium: quota is whatever is used plus a constant headroom. */
  const chromium = (used: number) => ({ usage: used, quota: used + HEADROOM })

  it('holds the first ceiling while the platform lets its own drift upward', async () => {
    const storage = await fresh()
    stub({ estimate: async () => chromium(0) })
    expect((await storage.estimate()).quota).toBe(HEADROOM)

    // 1.615 GB later the platform says 12.353 GB. A caller reading a gauge would see it never fill.
    stub({ estimate: async () => chromium(1_615_000_000) })
    const after = await storage.estimate()
    expect(after.quota, 'the ceiling must not have moved').toBe(HEADROOM)
    expect(chromium(1_615_000_000).quota, 'the control: the platform really did raise its own')
      .toBeGreaterThan(HEADROOM)
  })

  it('makes the gauge and the pressure check work, which is the whole point', async () => {
    const storage = await fresh()
    stub({ estimate: async () => chromium(0) })
    await storage.estimate()
    stub({ estimate: async () => chromium(10_000_000_000) })
    const { usage, quota } = await storage.estimate()
    // 10 GB into a 10.74 GB ceiling: nearly full, and now sayable
    expect(quota! - usage!).toBeLessThan(1_000_000_000)
    expect(usage! / quota!).toBeGreaterThan(0.9)
  })

  /** A ceiling that really does come down, because the disk is filling, has to be followed. */
  it('follows the platform downward, since that direction is never optimistic', async () => {
    const storage = await fresh()
    stub({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })
    await storage.estimate()
    stub({ estimate: async () => ({ usage: 0, quota: 2_000_000_000 }) })
    expect((await storage.estimate()).quota).toBe(2_000_000_000)
  })

  /**
   * Never below what is already stored, or `quota - usage` goes negative and takes every caller's
   * arithmetic with it. Reachable on Chromium, which goes on allowing writes past the first ceiling
   * it offered.
   */
  it('never reports a ceiling under the bytes already held', async () => {
    const storage = await fresh()
    stub({ estimate: async () => chromium(0) })
    await storage.estimate()
    stub({ estimate: async () => chromium(20_000_000_000) })
    const { usage, quota } = await storage.estimate()
    expect(quota).toBe(20_000_000_000)
    expect(quota! - usage!, 'the honest answer for an origin at its ceiling is zero, never negative').toBe(0)
  })

  it('says nothing about a quota the platform did not state', async () => {
    const storage = await fresh()
    stub({ estimate: async () => ({ usage: 5 }) })
    expect((await storage.estimate()).quota).toBeUndefined()
  })

  /**
   * A walk that cannot finish is not a reason to refuse. The browser's figure is a floor, not a
   * guess, so falling back to it is a downgrade in precision and never in safety.
   */
  it('falls back to the browser figure when the origin will not enumerate', async () => {
    const storage = await fresh()
    stub({ estimate: async () => REPORTED, getDirectory: async () => ({ values: () => { throw new Error('nope') } }) })
    expect((await storage.estimate()).usage).toBe(REPORTED.usage)
  })

  it('falls back when there is no origin private file system at all', async () => {
    const storage = await fresh()
    stub({ estimate: async () => REPORTED })
    expect((await storage.estimate()).usage).toBe(REPORTED.usage)
  })

  it('falls back when the file system cannot even be opened', async () => {
    const storage = await fresh()
    stub({ estimate: async () => REPORTED, getDirectory: async () => { throw new Error('no opfs') } })
    expect((await storage.estimate()).usage).toBe(REPORTED.usage)
  })

  /**
   * A file something else holds an exclusive sync access handle for cannot be opened by anyone, and
   * an origin under a running torrent client is full of them. A walk that gave up on the first would
   * report nothing for exactly the origins holding the most, so the answer is a floor: short by the
   * files open right now, never long.
   */
  it('skips a file it cannot open instead of abandoning the walk', async () => {
    const storage = await fresh()
    const locked: Handle = { getFile: async () => { throw new Error('NoModificationAllowedError') } }
    stub({ estimate: async () => ({ usage: 0 }), getDirectory: async () => dir([file(500), locked, file(300)]) })
    expect((await storage.estimate()).usage).toBe(800)
  })

  /**
   * The two bounds are about not hanging rather than about being right: a cycle is impossible in this
   * file system, but a pathological tree is not. Hitting either returns what was counted so far.
   */
  it('stops descending past eight levels', async () => {
    const storage = await fresh()
    const deep = (levels: number): Handle => levels === 0 ? dir([file(1_000)]) : dir([file(1), deep(levels - 1)])
    stub({ estimate: async () => ({ usage: 0 }), getDirectory: async () => deep(3) })
    expect((await storage.estimate()).usage, 'a shallow tree is counted whole').toBe(1_003)
    stub({ estimate: async () => ({ usage: 0 }), getDirectory: async () => deep(40) })
    // nine levels of one byte each, and the 1000 at the bottom is never reached
    expect((await storage.estimate()).usage).toBe(9)
  })

  it('stops counting past twenty thousand entries', async () => {
    const storage = await fresh()
    stub({
      estimate: async () => ({ usage: 0 }),
      getDirectory: async () => dir(Array.from({ length: 20_050 }, () => file(1))),
    })
    expect((await storage.estimate()).usage).toBe(20_000)
  })

  /** No Storage API at all answers the empty estimate rather than throwing, so callers need no guard. */
  it('degrades to an empty estimate where the API is absent', async () => {
    const storage = await fresh()
    vi.stubGlobal('navigator', {})
    expect(await storage.estimate()).toEqual({})
    expect(await storage.persist()).toBe(false)
    expect(await storage.persisted()).toBe(false)
    await expect(storage.getDirectory()).rejects.toThrow(/origin private file system/)
  })

  it('passes persist, persisted and getDirectory straight through', async () => {
    const storage = await fresh()
    const root = dir([])
    stub({ persist: async () => true, persisted: async () => true, getDirectory: async () => root })
    expect(await storage.persist()).toBe(true)
    expect(await storage.persisted()).toBe(true)
    expect(await storage.getDirectory()).toBe(root)
  })
})
