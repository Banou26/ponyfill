import { afterEach, describe, expect, it, vi } from 'vitest'

import { showDirectoryPicker, showOpenFilePicker, showSaveFilePicker } from '../src/file-system'

/**
 * The pickers, driven without a browser.
 *
 * The engine facts they are built on were measured with one, and are recorded in the module: two
 * engines of three have no picker at all, all three carry `webkitdirectory` and the input's `cancel`
 * event, all three refuse to clone an object holding its methods as own properties, and all three
 * disagree about the order a directory input hands files over in. What is checked here is that the
 * code does the thing those measurements argue for, on every path including the ones a browser makes
 * awkward to reach: a cancel, a cross origin frame, an empty folder, a document that is not there.
 */
afterEach(() => { vi.unstubAllGlobals() })

const fileWithPath = (path: string, bytes = 1): File => {
  const name = path.split('/').pop()!
  const file = new File([new Uint8Array(bytes)], name)
  Object.defineProperty(file, 'webkitRelativePath', { value: path.includes('/') ? path : '' })
  return file
}

type FakeInput = {
  type: string
  multiple: boolean
  accept: string
  webkitdirectory: boolean
  style: { display: string }
  files: File[] | null
  attributes: Record<string, string>
  attached: boolean
  clicks: number
  fire: (event: 'change' | 'cancel') => void
}

/**
 * A document whose one input answers the click however the test says, so every branch is reachable.
 *
 * `answer` runs on `click()`, which is where a real picker would open, and the test decides what
 * comes back: files, a cancel, or nothing at all for the case where the promise must simply stay
 * pending rather than resolving to something invented.
 */
const stubDocument = (answer: (input: FakeInput) => void) => {
  const made: FakeInput[] = []
  const listeners = new Map<FakeInput, Map<string, () => void>>()
  const document = {
    createElement: () => {
      const input: FakeInput = {
        type: '', multiple: false, accept: '', webkitdirectory: false,
        style: { display: '' }, files: null, attributes: {}, attached: false, clicks: 0,
        fire: (event) => listeners.get(input)?.get(event)?.(),
      }
      const own = new Map<string, () => void>()
      listeners.set(input, own)
      Object.assign(input, {
        setAttribute: (key: string, value: string) => { input.attributes[key] = value },
        addEventListener: (name: string, fn: () => void) => own.set(name, fn),
        remove: () => { input.attached = false },
        click: () => { input.clicks++; answer(input) },
      })
      made.push(input)
      return input
    },
    body: { append: (input: FakeInput) => { input.attached = true } },
  }
  vi.stubGlobal('document', document)
  return made
}

/** A window that is not framed, which is the ordinary case and the one the natives are used in. */
const topLevel = () => {
  const w: { self?: unknown, top?: unknown } = {}
  w.self = w
  w.top = w
  vi.stubGlobal('window', w)
}

const framed = () => {
  vi.stubGlobal('window', {
    self: {},
    top: { get location (): never { throw new DOMException('blocked', 'SecurityError') } },
  })
}

describe('showSaveFilePicker refuses before it spends the gesture', () => {
  it('delegates where the platform can actually show one', async () => {
    const handle = { kind: 'file', name: 'x.mkv' }
    const seen: unknown[] = []
    topLevel()
    vi.stubGlobal('showSaveFilePicker', async (o: unknown) => { seen.push(o); return handle })
    await expect(showSaveFilePicker({ suggestedName: 'x.mkv' })).resolves.toBe(handle)
    expect(seen, 'the options go through untouched').toEqual([{ suggestedName: 'x.mkv' }])
  })

  /**
   * THE ORDERING THAT MATTERS. The platform would reject this too, but only after consuming part of
   * the click, so the fallback the caller reaches for next can fail as well.
   */
  it('refuses a cross origin frame without calling the platform at all', async () => {
    let called = 0
    framed()
    vi.stubGlobal('showSaveFilePicker', async () => { called++; return {} })
    await expect(showSaveFilePicker()).rejects.toThrow(/cross origin/)
    expect(called, 'the gesture must not have been spent').toBe(0)
  })

  it('refuses where the engine has no picker, and never falls back to a download', async () => {
    topLevel()
    vi.stubGlobal('showSaveFilePicker', undefined)
    const made = stubDocument(() => { throw new Error('a save must never open an input') })
    await expect(showSaveFilePicker()).rejects.toThrow(/no file save picker/)
    expect(made, 'saving has no fallback on purpose').toEqual([])
  })

  /**
   * `NotAllowedError` and never `AbortError`. The platform uses `AbortError` for the PERSON
   * cancelling, and a caller that cannot tell those apart shows a failure for something somebody
   * chose to do.
   */
  it('names its refusals so a caller cannot mistake them for a cancel', async () => {
    framed()
    vi.stubGlobal('showSaveFilePicker', undefined)
    await expect(showSaveFilePicker()).rejects.toMatchObject({ name: 'NotAllowedError' })
    topLevel()
    await expect(showSaveFilePicker()).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  it('treats a same origin ancestor as fine, since only another origin is refused', async () => {
    vi.stubGlobal('window', { self: {}, top: { location: { origin: 'https://example.test' } } })
    vi.stubGlobal('showSaveFilePicker', async () => 'ok')
    await expect(showSaveFilePicker()).resolves.toBe('ok')
  })
})

describe('showOpenFilePicker answers handles on every engine', () => {
  it('hands back the PLATFORM handle untouched where there is a picker', async () => {
    const native = { kind: 'file', name: 'real.mkv' }
    const seen: unknown[] = []
    topLevel()
    vi.stubGlobal('showOpenFilePicker', async (o: unknown) => { seen.push(o); return [native] })
    const [handle] = await showOpenFilePicker({ multiple: false })
    // identity, not shape: wrapping it would take away the one thing a native handle is worth having
    expect(handle).toBe(native)
    expect(seen).toEqual([{ multiple: false }])
  })

  it('opens an input where the engine has no picker, and answers the same shape', async () => {
    topLevel()
    vi.stubGlobal('showOpenFilePicker', undefined)
    stubDocument((input) => { input.files = [fileWithPath('E01.mkv', 7)]; input.fire('change') })
    const [handle] = await showOpenFilePicker()
    expect(handle!.kind).toBe('file')
    expect(handle!.name).toBe('E01.mkv')
    expect((await handle!.getFile()).size).toBe(7)
  })

  /**
   * The platform refuses a cross origin frame at CALL time, so trying it there spends part of the
   * click for nothing. An input still works in that frame, so this is strictly better than refusing.
   */
  it('skips a native picker it knows will refuse, and uses the input instead', async () => {
    let called = 0
    framed()
    vi.stubGlobal('showOpenFilePicker', async () => { called++; return [] })
    stubDocument((input) => { input.files = [fileWithPath('a.bin')]; input.fire('change') })
    const handles = await showOpenFilePicker()
    expect(called, 'the gesture must not have been spent on a refusal').toBe(0)
    expect(handles).toHaveLength(1)
  })

  it('rejects a dismissed picker as a cancel, with the platform name for it', async () => {
    topLevel()
    vi.stubGlobal('showOpenFilePicker', undefined)
    stubDocument((input) => input.fire('cancel'))
    await expect(showOpenFilePicker()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('takes the input back out of the document, whichever way the pick ended', async () => {
    topLevel()
    vi.stubGlobal('showOpenFilePicker', undefined)
    const picked = stubDocument((input) => { input.files = [fileWithPath('a.bin')]; input.fire('change') })
    await showOpenFilePicker()
    const cancelled = stubDocument((input) => input.fire('cancel'))
    await showOpenFilePicker().catch(() => {})
    expect([picked[0]!.attached, cancelled[0]!.attached], 'one element per pick would be left behind').toEqual([false, false])
    expect([picked[0]!.style.display, picked[0]!.attributes['aria-hidden']]).toEqual(['none', 'true'])
  })

  it('carries multiple and the accepted types onto the input', async () => {
    topLevel()
    vi.stubGlobal('showOpenFilePicker', undefined)
    const made = stubDocument((input) => { input.files = []; input.fire('change') })
    await showOpenFilePicker({
      multiple: true,
      types: [{ description: 'video', accept: { 'video/x-matroska': ['.mkv'], '*/*': ['.bin'] } }],
    })
    expect(made[0]!.multiple).toBe(true)
    // both halves of each entry, and no `*` pattern, which filters nothing while claiming it does
    expect(made[0]!.accept.split(',').sort()).toEqual(['.bin', '.mkv', 'video/x-matroska'])
  })

  it('refuses rather than hanging where there is no document to open one from', async () => {
    topLevel()
    vi.stubGlobal('showOpenFilePicker', undefined)
    vi.stubGlobal('document', undefined)
    await expect(showOpenFilePicker()).rejects.toMatchObject({ name: 'NotAllowedError' })
  })
})

describe('showDirectoryPicker rebuilds the tree the platform would have given', () => {
  const pickTree = (paths: string[]) => {
    topLevel()
    vi.stubGlobal('showDirectoryPicker', undefined)
    stubDocument((input) => { input.files = paths.map((p) => fileWithPath(p)); input.fire('change') })
    return showDirectoryPicker()
  }

  const namesOf = async (directory: FileSystemDirectoryHandle) => {
    const out: string[] = []
    for await (const [name] of directory.entries()) out.push(name)
    return out
  }

  it('hands back the PLATFORM handle untouched where there is a picker', async () => {
    const native = { kind: 'directory', name: 'real' }
    topLevel()
    vi.stubGlobal('showDirectoryPicker', async () => native)
    expect(await showDirectoryPicker({ mode: 'read' })).toBe(native)
  })

  it('names the root after the picked folder and drops it from every path under it', async () => {
    const root = await pickTree(['Pack/a.bin', 'Pack/Subs/E01.ass'])
    expect(root.kind).toBe('directory')
    expect(root.name, 'the first segment is the folder itself, not a directory inside it').toBe('Pack')
    expect(await namesOf(root)).toEqual(['Subs', 'a.bin'])
    const subs = await root.getDirectoryHandle('Subs')
    expect(await namesOf(subs)).toEqual(['E01.ass'])
  })

  /**
   * THE PICK. The same tree comes out of an input in one order on Chromium and the opposite on
   * Firefox and WebKit, measured 2026-09-03, so the order is chosen here rather than inherited.
   */
  it('iterates in one order whatever order the engine handed the files over in', async () => {
    const forwards = await pickTree(['P/a.bin', 'P/b.bin', 'P/c.bin'])
    const backwards = await pickTree(['P/c.bin', 'P/b.bin', 'P/a.bin'])
    expect(await namesOf(forwards)).toEqual(['a.bin', 'b.bin', 'c.bin'])
    expect(await namesOf(backwards)).toEqual(await namesOf(forwards))
  })

  it('answers the SAME handle for the same entry, so isSameEntry means something', async () => {
    const root = await pickTree(['P/a.bin'])
    const one = await root.getFileHandle('a.bin')
    const two = await root.getFileHandle('a.bin')
    expect(one).toBe(two)
    expect(await one.isSameEntry(two)).toBe(true)
    expect(await one.isSameEntry(root as unknown as FileSystemFileHandle)).toBe(false)
  })

  it('keys values(), keys() and the async iterator off the same order', async () => {
    const root = await pickTree(['P/b.bin', 'P/a.bin'])
    const keys: string[] = []
    for await (const key of root.keys()) keys.push(key)
    const values: string[] = []
    for await (const value of root.values()) values.push(value.name)
    const iterated: string[] = []
    for await (const [name] of root) iterated.push(name)
    expect([keys, values, iterated]).toEqual([['a.bin', 'b.bin'], ['a.bin', 'b.bin'], ['a.bin', 'b.bin']])
  })

  it('reports a missing entry and a wrong kind the way the platform names them', async () => {
    const root = await pickTree(['P/a.bin', 'P/Subs/E01.ass'])
    await expect(root.getFileHandle('nope')).rejects.toMatchObject({ name: 'NotFoundError' })
    await expect(root.getFileHandle('Subs')).rejects.toMatchObject({ name: 'TypeMismatchError' })
    await expect(root.getDirectoryHandle('a.bin')).rejects.toMatchObject({ name: 'TypeMismatchError' })
  })

  it('resolves a descendant to its path, and something else to null', async () => {
    const root = await pickTree(['P/Subs/E01.ass'])
    const subs = await root.getDirectoryHandle('Subs')
    const leaf = await subs.getFileHandle('E01.ass')
    expect(await root.resolve(leaf)).toEqual(['Subs', 'E01.ass'])
    expect(await root.resolve(root)).toEqual([])
    expect(await root.resolve({ kind: 'file' } as unknown as FileSystemFileHandle)).toBe(null)
  })

  it('reports an empty folder as an empty folder rather than a cancel', async () => {
    const root = await pickTree([])
    expect(root.kind).toBe('directory')
    // the name only ever comes from a file's path, so a folder with none cannot supply one
    expect(root.name).toBe('')
    expect(await namesOf(root)).toEqual([])
  })

  it('lets a path win over a file of the same name, since a path proves it is a folder', async () => {
    const root = await pickTree(['P/x', 'P/x/inner.bin'])
    const x = await root.getDirectoryHandle('x')
    expect(await namesOf(x)).toEqual(['inner.bin'])
  })
})

describe('what a wrapped handle refuses, which is everything that writes', () => {
  const pick = (paths: string[]) => {
    topLevel()
    vi.stubGlobal('showDirectoryPicker', undefined)
    stubDocument((input) => { input.files = paths.map((p) => fileWithPath(p)); input.fire('change') })
    return showDirectoryPicker()
  }

  it('refuses a write to a chosen folder at the ASK, without opening anything', async () => {
    topLevel()
    vi.stubGlobal('showDirectoryPicker', undefined)
    const made = stubDocument(() => { throw new Error('nothing to open: there is no write route') })
    await expect(showDirectoryPicker({ mode: 'readwrite' })).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(made, 'a handle whose every write fails later is worse than a refusal now').toEqual([])
  })

  it('refuses createWritable, removeEntry and every create', async () => {
    const root = await pick(['P/a.bin'])
    const file = await root.getFileHandle('a.bin')
    await expect(file.createWritable()).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(root.removeEntry('a.bin')).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(root.getFileHandle('new.bin', { create: true })).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(root.getDirectoryHandle('new', { create: true })).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  /**
   * THE ONE THAT CANNOT BE ABSORBED, so what is picked is how it fails.
   *
   * A native handle clones and comes back out of IndexedDB still usable. This one refers to a
   * snapshot and cannot. Left as an ordinary object it would clone SUCCESSFULLY, come back with its
   * prototype gone and every method with it, and fail after a reload with nothing pointing at the
   * pick. Own properties are what make the failure land here instead, on all three engines.
   */
  it('cannot be stored, and throws at the store rather than after the reload', async () => {
    const root = await pick(['P/a.bin'])
    const file = await root.getFileHandle('a.bin')
    for (const handle of [root, file]) {
      expect(() => structuredClone(handle), 'a silent clone is a dead handle later').toThrow()
      try { structuredClone(handle) } catch (error) { expect((error as Error).name).toBe('DataCloneError') }
    }
  })
})
