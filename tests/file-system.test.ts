import { afterEach, describe, expect, it, vi } from 'vitest'

import { showSaveFilePicker } from '../src/file-system'

/**
 * The picker refuses at CALL time in two cases a property probe cannot see, and each refusal spends
 * part of the transient activation a caller's fallback chain still needs. So both are raised before
 * the call, with an error a caller can tell apart from a cancel.
 */
afterEach(() => { vi.unstubAllGlobals() })

const stubWindow = (over: Record<string, unknown>) => {
  vi.stubGlobal('window', { self: {}, ...over })
  vi.stubGlobal('showSaveFilePicker', over.picker)
}

describe('showSaveFilePicker refuses before it spends the gesture', () => {
  it('delegates where the platform can actually show one', async () => {
    const handle = { kind: 'file', name: 'x.mkv' }
    const seen: unknown[] = []
    const w = { self: {} as unknown }
    w.self = w
    vi.stubGlobal('window', { ...w, top: w })
    vi.stubGlobal('showSaveFilePicker', async (o: unknown) => { seen.push(o); return handle })
    await expect(showSaveFilePicker({ suggestedName: 'x.mkv' })).resolves.toBe(handle)
    expect(seen, 'the options go through untouched').toEqual([{ suggestedName: 'x.mkv' }])
  })

  /**
   * THE ORDERING THAT MATTERS. The platform would reject this too, but only after consuming part of
   * the click, so the fallback the caller reaches for next can fail as well. Never calling it is the
   * whole fix.
   */
  it('refuses a cross origin frame without calling the platform at all', async () => {
    let called = 0
    const top = { get location (): never { throw new DOMException('blocked', 'SecurityError') } }
    vi.stubGlobal('window', { self: {}, top })
    vi.stubGlobal('showSaveFilePicker', async () => { called++; return {} })
    await expect(showSaveFilePicker()).rejects.toThrow(/cross origin/)
    expect(called, 'the gesture must not have been spent').toBe(0)
  })

  it('refuses where the engine has no picker', async () => {
    const w = { self: {} as unknown }
    w.self = w
    vi.stubGlobal('window', { ...w, top: w })
    vi.stubGlobal('showSaveFilePicker', undefined)
    await expect(showSaveFilePicker()).rejects.toThrow(/no file save picker/)
  })

  /**
   * `NotAllowedError` and never `AbortError`. The platform uses `AbortError` for the PERSON
   * cancelling, and ripple's `isSaveCancelled` matches on exactly that, so a refusal wearing the
   * cancel's name would silently swallow a real failure.
   */
  it('names its refusals so a caller cannot mistake them for a cancel', async () => {
    vi.stubGlobal('window', { self: {}, top: { get location (): never { throw new Error('x') } } })
    vi.stubGlobal('showSaveFilePicker', undefined)
    await expect(showSaveFilePicker()).rejects.toMatchObject({ name: 'NotAllowedError' })
    const w = { self: {} as unknown }
    w.self = w
    vi.stubGlobal('window', { ...w, top: w })
    await expect(showSaveFilePicker()).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  it('treats a same origin ancestor as fine, since only another origin is refused', async () => {
    const top = { location: { origin: 'https://example.test' } }
    vi.stubGlobal('window', { self: {}, top })
    vi.stubGlobal('showSaveFilePicker', async () => 'ok')
    await expect(showSaveFilePicker()).resolves.toBe('ok')
  })
})
