import { afterEach, describe, expect, it, vi } from 'vitest'

import { permissions } from '../src/permissions'

/**
 * The four ways `query()` can behave, three of which are the same question coming back unanswered.
 *
 * The shapes are NOT interchangeable, and that is the point of wrapping it: a name an engine does
 * not know can throw synchronously, which a `.catch` on the returned promise never sees. Getting
 * that wrong turns a missing permission name into an uncaught exception at whatever moment the
 * feature is first used.
 */
const PERSISTENT = { name: 'persistent-storage' } as PermissionDescriptor

afterEach(() => { vi.unstubAllGlobals() })

describe('permissions.query answers a state, or says the browser will decide', () => {
  it('passes a real state straight through, all three of them', async () => {
    for (const state of ['granted', 'denied', 'prompt'] as const) {
      vi.stubGlobal('navigator', { permissions: { query: async () => ({ state }) } })
      expect((await permissions.query(PERSISTENT)).state).toBe(state)
    }
  })

  it('hands the descriptor to the platform untouched', async () => {
    const seen: PermissionDescriptor[] = []
    vi.stubGlobal('navigator', { permissions: { query: async (d: PermissionDescriptor) => { seen.push(d); return { state: 'granted' } } } })
    await permissions.query(PERSISTENT)
    expect(seen).toEqual([PERSISTENT])
  })

  it('says prompt where there is no Permissions API at all', async () => {
    vi.stubGlobal('navigator', {})
    expect((await permissions.query(PERSISTENT)).state).toBe('prompt')
  })

  it('says prompt where the query REJECTS for a name the engine does not implement', async () => {
    vi.stubGlobal('navigator', { permissions: { query: async () => { throw new Error('TypeError') } } })
    expect((await permissions.query(PERSISTENT)).state).toBe('prompt')
  })

  /**
   * The case a `.catch` cannot reach. This is why the `await` sits inside the `try` rather than the
   * call carrying a `.catch`, and it is the only difference between the two that matters.
   */
  it('says prompt where the query THROWS SYNCHRONOUSLY, which a catch on the promise never sees', async () => {
    vi.stubGlobal('navigator', { permissions: { query: () => { throw new TypeError('unknown name') } } })
    await expect(permissions.query(PERSISTENT)).resolves.toEqual({ state: 'prompt' })
  })

  /** An engine answering something outside the union is answering nothing usable. */
  it('says prompt for a state it does not recognise', async () => {
    vi.stubGlobal('navigator', { permissions: { query: async () => ({ state: 'maybe' }) } })
    expect((await permissions.query(PERSISTENT)).state).toBe('prompt')
    vi.stubGlobal('navigator', { permissions: { query: async () => undefined } })
    expect((await permissions.query(PERSISTENT)).state).toBe('prompt')
  })

  /**
   * `prompt` and not `denied`, and the distinction is the pick rather than a detail. An engine that
   * cannot be asked has not refused anything, and treating its silence as refusal costs the person a
   * control that might have worked.
   */
  it('never answers denied for a question it could not ask', async () => {
    for (const nav of [{}, { permissions: { query: async () => { throw new Error('x') } } }]) {
      vi.stubGlobal('navigator', nav)
      expect((await permissions.query(PERSISTENT)).state).not.toBe('denied')
    }
  })
})
