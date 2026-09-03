import { afterEach, describe, expect, it, vi } from 'vitest'

import * as pkg from '../src/index'
import { storage } from '../src/storage'

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
  it('exports nothing the platform does not have', () => {
    expect(Object.keys(pkg).sort()).toEqual(['storage'])
    expect(Object.keys(storage).sort()).toEqual(['estimate', 'getDirectory', 'persist', 'persisted'])
  })

  it('answers the shape the platform answers, with no extra fields', async () => {
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
    stub({ estimate: async () => REPORTED, getDirectory: async () => dir([file(ON_DISK)]) })
    expect((await storage.estimate()).usage).toBe(ON_DISK + OTHER)
    expect(OTHER, 'the non file system part is real and must survive').toBeGreaterThan(1_800_000)
  })

  it('replaces the whole figure when the browser volunteers no breakdown', async () => {
    stub({ estimate: async () => ({ usage: 752, quota: 1 }), getDirectory: async () => dir([file(ON_DISK)]) })
    expect((await storage.estimate()).usage).toBe(ON_DISK)
  })

  /** The walk can only ever RAISE the answer: a browser over-reporting has never been observed. */
  it('never lowers the browser figure', async () => {
    stub({ estimate: async () => ({ usage: 9_000, quota: 1 }), getDirectory: async () => dir([file(10)]) })
    expect((await storage.estimate()).usage).toBe(9_000)
  })

  it('leaves quota exactly as the browser stated it', async () => {
    stub({ estimate: async () => REPORTED, getDirectory: async () => dir([file(ON_DISK)]) })
    expect((await storage.estimate()).quota).toBe(REPORTED.quota)
  })

  /**
   * A walk that cannot finish is not a reason to refuse. The browser's figure is a floor, not a
   * guess, so falling back to it is a downgrade in precision and never in safety.
   */
  it('falls back to the browser figure when the origin will not enumerate', async () => {
    stub({ estimate: async () => REPORTED, getDirectory: async () => ({ values: () => { throw new Error('nope') } }) })
    expect((await storage.estimate()).usage).toBe(REPORTED.usage)
  })

  it('falls back when there is no origin private file system at all', async () => {
    stub({ estimate: async () => REPORTED })
    expect((await storage.estimate()).usage).toBe(REPORTED.usage)
  })

  it('falls back when the file system cannot even be opened', async () => {
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
    const locked: Handle = { getFile: async () => { throw new Error('NoModificationAllowedError') } }
    stub({ estimate: async () => ({ usage: 0 }), getDirectory: async () => dir([file(500), locked, file(300)]) })
    expect((await storage.estimate()).usage).toBe(800)
  })

  /**
   * The two bounds are about not hanging rather than about being right: a cycle is impossible in this
   * file system, but a pathological tree is not. Hitting either returns what was counted so far.
   */
  it('stops descending past eight levels', async () => {
    const deep = (levels: number): Handle => levels === 0 ? dir([file(1_000)]) : dir([file(1), deep(levels - 1)])
    stub({ estimate: async () => ({ usage: 0 }), getDirectory: async () => deep(3) })
    expect((await storage.estimate()).usage, 'a shallow tree is counted whole').toBe(1_003)
    stub({ estimate: async () => ({ usage: 0 }), getDirectory: async () => deep(40) })
    // nine levels of one byte each, and the 1000 at the bottom is never reached
    expect((await storage.estimate()).usage).toBe(9)
  })

  it('stops counting past twenty thousand entries', async () => {
    stub({
      estimate: async () => ({ usage: 0 }),
      getDirectory: async () => dir(Array.from({ length: 20_050 }, () => file(1))),
    })
    expect((await storage.estimate()).usage).toBe(20_000)
  })

  /** No Storage API at all answers the empty estimate rather than throwing, so callers need no guard. */
  it('degrades to an empty estimate where the API is absent', async () => {
    vi.stubGlobal('navigator', {})
    expect(await storage.estimate()).toEqual({})
    expect(await storage.persist()).toBe(false)
    expect(await storage.persisted()).toBe(false)
    await expect(storage.getDirectory()).rejects.toThrow(/origin private file system/)
  })

  it('passes persist, persisted and getDirectory straight through', async () => {
    const root = dir([])
    stub({ persist: async () => true, persisted: async () => true, getDirectory: async () => root })
    expect(await storage.persist()).toBe(true)
    expect(await storage.persisted()).toBe(true)
    expect(await storage.getDirectory()).toBe(root)
  })
})
