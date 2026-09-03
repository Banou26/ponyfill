/**
 * The File System Access pickers, with the same names and one behaviour picked for each.
 *
 * ## What was measured, on what, and when
 *
 * 2026-09-03, one machine, three engines driven headless through Playwright, same probe in each:
 *
 * | | Chromium 149 | Firefox 151 | WebKit 26 |
 * | --- | --- | --- | --- |
 * | `showOpenFilePicker` / `showDirectoryPicker` / `showSaveFilePicker` | all present | all absent | all absent |
 * | `FileSystemHandle` and friends as globals | present | present | ABSENT |
 * | `queryPermission` on a native handle | function | undefined | no handles to ask |
 * | `<input>.webkitdirectory` | yes | yes | yes |
 * | the input's `cancel` event | yes | yes | yes |
 * | an object holding its methods as OWN properties, cloned | DataCloneError | DataCloneError | DataCloneError |
 * | the same object with its methods on a PROTOTYPE, cloned | clones, silently | clones, silently | clones, silently |
 * | `<input webkitdirectory>` file order, same tree | `a.bin`, `sub/b.bin` | `sub/b.bin`, `a.bin` | `sub/b.bin`, `a.bin` |
 *
 * Four of those rows decide something below, and each is noted where it does.
 *
 * ## The divergence
 *
 * Two engines of three have NO picker at all, so an app that wants files from a person carries a
 * second route for them: an `<input type="file">`, a `File` where the others have a handle, and a
 * union type threaded through everything downstream. That union is the cost, and it is paid in every
 * file the bytes pass through rather than at the boundary where the difference actually is.
 *
 * `showSaveFilePicker` diverges a second way, which is why it is the one entry here with no
 * fallback. Chromium exposes it whether or not it can be used and refuses at CALL time in two cases a
 * property probe cannot see: a cross origin ancestor frame ("Cross origin sub frames aren't allowed
 * to show a file picker") and no transient activation.
 *
 * ## The picks
 *
 * READING ALWAYS WORKS, and always answers handles. `showOpenFilePicker` and `showDirectoryPicker`
 * open the platform's picker where there is one and hand back its handles untouched; where there is
 * none they open an `<input type="file">` and wrap what comes back in the same shape. One call, one
 * return type, no branch in the caller.
 *
 * WRITING IS REFUSED RATHER THAN FAKED. `showSaveFilePicker` has no fallback, `showDirectoryPicker`
 * refuses `mode: 'readwrite'` where it has no native picker, and a wrapped handle's
 * `createWritable()` throws. There is no way to write to a chosen location without the platform's
 * picker, and a download that appeared in someone's downloads folder instead would be a different
 * thing wearing the same name.
 *
 * REFUSALS HAPPEN BEFORE THE GESTURE IS SPENT, and are named so a caller can tell them from a
 * cancel. A caller with a fallback chain has one transient activation, and a picker that rejects at
 * call time has already consumed part of it, so the fallback reached for next can fail too.
 * `NotAllowedError` for every refusal and never `AbortError`, because `AbortError` is what the
 * platform throws when the PERSON cancels: a caller that cannot tell those apart reports a failure
 * for something somebody chose to do.
 *
 * A WRAPPED HANDLE CANNOT BE PERSISTED, AND SAYS SO LOUDLY. This is the one difference that cannot be
 * absorbed, so what is picked is how it FAILS. A native handle survives `structuredClone` and comes
 * back out of IndexedDB still usable, which is the whole reason handles are worth having; a wrapper
 * around a `File` cannot, because the thing it refers to is a snapshot rather than an entry on a
 * disk. Left as an ordinary object it would clone SUCCESSFULLY and come back with its prototype gone
 * and every method with it, so the app would store it, reload, and fail somewhere else entirely with
 * nothing pointing back here. Measured on all three engines above, both halves of that.
 *
 * So every wrapped handle carries its methods as OWN properties, which makes `structuredClone` and
 * `IDBObjectStore.put` throw `DataCloneError` at the moment of the mistake. `await set(key, handle)`
 * rejecting where the browser cannot remember it is the honest shape, and it is one `.catch` at the
 * one place that cares rather than a capability probe at every call site.
 *
 * WHAT IS NOT ABSORBED, deliberately:
 *
 *  - the fallback chain for saving. An anchor download, a service worker sink, or holding bytes in
 *    memory are not platform names, and choosing between them is a product decision about what a page
 *    does when it cannot save.
 *  - `queryPermission` and `requestPermission` on a handle. They are Chromium's alone, absent from
 *    Firefox even on its own native handles, and they are methods on an object the caller already
 *    holds rather than a name this package could export without inventing one.
 *  - re-opening. Nothing here makes a snapshot durable. An app that needs the bytes after a reload
 *    has to copy them somewhere it owns, which spends the origin's quota and is therefore its
 *    decision to make rather than this package's to make silently.
 */

type FilePickerAcceptType = { description?: string, accept: Record<string, string[]> }

type SaveFilePickerOptions = {
  suggestedName?: string
  types?: FilePickerAcceptType[]
  excludeAcceptAllOption?: boolean
  id?: string
  startIn?: unknown
}

type OpenFilePickerOptions = {
  multiple?: boolean
  types?: FilePickerAcceptType[]
  excludeAcceptAllOption?: boolean
  id?: string
  startIn?: unknown
}

type DirectoryPickerOptions = {
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: unknown
}

type SaveFilePicker = (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>
type OpenFilePicker = (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>
type DirectoryPicker = (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>

const NO_SAVE_PICKER = 'this browser has no file save picker'
const NO_FRAMED_PICKER = 'a cross origin frame cannot show a file save picker'
const NO_DOCUMENT = 'there is no document here to open a file picker from'
const NO_WRITE = 'this file was opened from a picker that cannot write, so there is nothing to write to'
const NO_WRITE_FOLDER = 'this browser cannot grant write access to a chosen folder'

const refuse = (message: string) => new DOMException(message, 'NotAllowedError')

/**
 * Whether this document is framed by another origin.
 *
 * Chromium exposes the pickers either way and refuses them at call time, so a property probe says
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

/**
 * The `accept` attribute for an `<input>`, from the picker's own `types`.
 *
 * Both halves of each entry go in. The attribute takes MIME types and extensions in one comma
 * separated list, and an engine that does not recognise one of them ignores that one rather than the
 * whole attribute, so listing both is strictly better than choosing. `*` patterns are dropped: they
 * are what `excludeAcceptAllOption: false` already means, and an `accept` of `*` filters nothing
 * while making the dialog claim it does.
 */
const acceptFrom = (types?: FilePickerAcceptType[]): string => {
  const out = new Set<string>()
  for (const type of types ?? []) {
    for (const [mime, extensions] of Object.entries(type.accept ?? {})) {
      if (mime && !mime.includes('*')) out.add(mime)
      for (const extension of extensions) out.add(extension)
    }
  }
  return [...out].join(',')
}

/**
 * One pick through a detached `<input type="file">`, resolving the files or rejecting like a cancel.
 *
 * The `cancel` event is what makes this a promise that always settles, and it is why this fallback is
 * worth having at all rather than being a hazard: measured present on all three engines above. An
 * engine without it would leave a picker that was dismissed pending forever, which is worse than not
 * offering one.
 *
 * NEEDS THE CALLER'S TRANSIENT ACTIVATION, exactly as the platform picker does. `click()` on a file
 * input opens nothing without a gesture, so this has to be reached synchronously from the handler,
 * and an `await` before it loses that. The same rule the native picker has, for the same reason.
 *
 * The input is attached and removed rather than left detached: a detached input's `click()` is
 * ignored by some engines, and leaving it in the document would leave one element per pick behind.
 */
const pickThroughInput = (setup: (input: HTMLInputElement) => void): Promise<File[]> => {
  const document = globalThis.document
  if (!document?.body) return Promise.reject(refuse(NO_DOCUMENT))
  return new Promise<File[]>((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    // out of layout and out of the accessibility tree: it is a mechanism, never something to look at
    input.style.display = 'none'
    input.setAttribute('aria-hidden', 'true')
    setup(input)
    const settle = (finish: () => void) => {
      input.remove()
      finish()
    }
    input.addEventListener('change', () => settle(() => resolve([...(input.files ?? [])])), { once: true })
    input.addEventListener(
      'cancel',
      // the platform's own name for "the person closed it", so a caller's cancel check keeps working
      () => settle(() => reject(new DOMException('the file picker was closed', 'AbortError'))),
      { once: true },
    )
    document.body.append(input)
    input.click()
  })
}

/**
 * The tree a pick is wrapped around, built once and shared by every handle that describes it.
 *
 * A node rather than a handle so `isSameEntry` can be identity on the node: two `getFileHandle` calls
 * for the same name answer the same object, which is what the platform's own handles do and what
 * anything holding a set of them expects.
 */
type FileNode = { kind: 'file', name: string, file: File }
type DirectoryNode = { kind: 'directory', name: string, children: Map<string, Node> }
type Node = FileNode | DirectoryNode

const handles = new WeakMap<Node, FileSystemFileHandle | FileSystemDirectoryHandle>()

/**
 * Entries in a fixed order, which the platform does not promise and the engines do not agree on.
 *
 * Measured above: the same tree comes out of `<input webkitdirectory>` in one order on Chromium and
 * the opposite on Firefox and WebKit. Sorted by code unit rather than `localeCompare`, because a
 * locale sensitive sort is one more thing that differs between two machines running the same code.
 */
const ordered = (children: Map<string, Node>): [string, Node][] =>
  [...children].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

const fileHandleFor = (node: FileNode): FileSystemFileHandle => {
  /*
   * EVERY METHOD IS AN OWN PROPERTY, and that is load bearing rather than a style.
   *
   * It is what makes `structuredClone` and an IndexedDB `put` throw `DataCloneError` on this object.
   * With the methods on a prototype the clone SUCCEEDS and yields a lifeless copy, so an app would
   * store this, reload, and fail later somewhere with no connection to the pick. Measured on
   * Chromium, Firefox and WebKit: own properties refuse, a prototype does not.
   */
  const handle = {
    kind: 'file' as const,
    name: node.name,
    /**
     * The same `File` every time, where the platform hands back a fresh one.
     *
     * A `File` from an input is a snapshot taken when it was picked. It cannot be re-read from disk,
     * so `lastModified` never moves and a staleness check across it can never fire. What it does do
     * is throw on READ once the file underneath has changed, so a pass over the bytes still refuses
     * to produce a mixture of two versions; it just reports it as a failed read rather than a
     * changed file.
     */
    getFile: async (): Promise<File> => node.file,
    createWritable: async (): Promise<never> => { throw refuse(NO_WRITE) },
    isSameEntry: async (other: unknown): Promise<boolean> => other === handles.get(node),
  }
  return handle as unknown as FileSystemFileHandle
}

const directoryHandleFor = (node: DirectoryNode): FileSystemDirectoryHandle => {
  const child = (name: string): Node | undefined => node.children.get(name)

  const entries = async function * (): AsyncGenerator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]> {
    for (const [name, entry] of ordered(node.children)) yield [name, handleFor(entry)]
  }

  const handle = {
    kind: 'directory' as const,
    name: node.name,
    entries,
    keys: async function * (): AsyncGenerator<string> {
      for (const [name] of ordered(node.children)) yield name
    },
    values: async function * (): AsyncGenerator<FileSystemFileHandle | FileSystemDirectoryHandle> {
      for (const [, entry] of ordered(node.children)) yield handleFor(entry)
    },
    [Symbol.asyncIterator]: entries,
    getFileHandle: async (name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle> => {
      // `create` is a write, and there is nothing here to write to
      if (options?.create) throw refuse(NO_WRITE)
      const found = child(name)
      if (!found) throw new DOMException(`there is no ${name} here`, 'NotFoundError')
      if (found.kind !== 'file') throw new DOMException(`${name} is a directory`, 'TypeMismatchError')
      return handleFor(found) as FileSystemFileHandle
    },
    getDirectoryHandle: async (name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle> => {
      if (options?.create) throw refuse(NO_WRITE)
      const found = child(name)
      if (!found) throw new DOMException(`there is no ${name} here`, 'NotFoundError')
      if (found.kind !== 'directory') throw new DOMException(`${name} is a file`, 'TypeMismatchError')
      return handleFor(found) as FileSystemDirectoryHandle
    },
    removeEntry: async (): Promise<never> => { throw refuse(NO_WRITE) },
    /** The path from here down to a handle in this tree, or null where it is not in it. */
    resolve: async (descendant: unknown): Promise<string[] | null> => {
      const search = (from: DirectoryNode, path: string[]): string[] | null => {
        for (const [name, entry] of ordered(from.children)) {
          if (handles.get(entry) === descendant) return [...path, name]
          if (entry.kind === 'directory') {
            const deeper = search(entry, [...path, name])
            if (deeper) return deeper
          }
        }
        return null
      }
      return handles.get(node) === descendant ? [] : search(node, [])
    },
    isSameEntry: async (other: unknown): Promise<boolean> => other === handles.get(node),
  }
  return handle as unknown as FileSystemDirectoryHandle
}

const handleFor = (node: Node): FileSystemFileHandle | FileSystemDirectoryHandle => {
  const made = handles.get(node)
  if (made) return made
  const fresh = node.kind === 'file' ? fileHandleFor(node) : directoryHandleFor(node)
  handles.set(node, fresh)
  return fresh
}

/**
 * The picked folder, rebuilt from the flat list an input hands over.
 *
 * `webkitRelativePath` is the whole tree already flattened: `Pack/Subs/E01.ass` for a folder called
 * `Pack`. The first segment is the folder's own name, so it becomes the root's name and is dropped
 * from every path under it, which is what makes this the same shape `showDirectoryPicker` returns.
 *
 * AN EMPTY FOLDER LOSES ITS NAME, and nothing can be done about that. The name is only ever learned
 * from a file's path, so a folder with nothing in it comes back named `''`. It is a real pick rather
 * than a cancel, since `change` fired, and reporting it as an empty directory is the closest true
 * answer available.
 *
 * A name used twice, once as a file and once as a folder, resolves to the folder, because a path
 * continuing through it proves it is one. Two files with the same path keep the last, which is what
 * a map does and what re-picking the same tree would do anyway.
 */
const treeFrom = (files: File[]): DirectoryNode => {
  const root: DirectoryNode = { kind: 'directory', name: '', children: new Map() }
  for (const file of files) {
    const relative = file.webkitRelativePath || file.name
    const segments = relative.split('/').filter(Boolean)
    if (!segments.length) continue
    const rooted = Boolean(file.webkitRelativePath) && segments.length > 1
    if (rooted && !root.name) root.name = segments[0]!
    const path = rooted ? segments.slice(1) : segments
    let level = root.children
    for (const name of path.slice(0, -1)) {
      const existing = level.get(name)
      const directory: DirectoryNode = existing?.kind === 'directory'
        ? existing
        : { kind: 'directory', name, children: new Map() }
      if (existing !== directory) level.set(name, directory)
      level = directory.children
    }
    const leaf = path[path.length - 1]!
    level.set(leaf, { kind: 'file', name: leaf, file })
  }
  return root
}

/**
 * Same name and signature, refusing before the gesture is spent and never faking a save.
 *
 * The one picker with no fallback. Writing to a location somebody chose needs the platform's picker,
 * and what an app does instead is a product decision rather than a shim: see the header.
 */
export const showSaveFilePicker: SaveFilePicker = async (options) => {
  const picker = (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker
  if (!picker) throw refuse(NO_SAVE_PICKER)
  if (framedByAnotherOrigin()) throw refuse(NO_FRAMED_PICKER)
  return picker(options)
}

/**
 * Same name and signature, answering file handles on every engine.
 *
 * The native picker is preferred wherever it can actually be shown, and its handles come back
 * UNTOUCHED: they are structured cloneable, they can be re-granted after a reload, and wrapping them
 * would take exactly that away. A cross origin frame is skipped rather than tried, since the platform
 * refuses there and refusing costs part of the click the fallback still needs.
 */
export const showOpenFilePicker: OpenFilePicker = async (options = {}) => {
  const picker = (globalThis as { showOpenFilePicker?: OpenFilePicker }).showOpenFilePicker
  if (picker && !framedByAnotherOrigin()) return picker(options)
  const accept = acceptFrom(options.types)
  const files = await pickThroughInput((input) => {
    input.multiple = options.multiple === true
    if (accept) input.accept = accept
  })
  return files.map((file) => handleFor({ kind: 'file', name: file.name, file }) as FileSystemFileHandle)
}

/**
 * Same name and signature, answering a directory handle wherever reading one is possible.
 *
 * `mode: 'readwrite'` is refused where there is no native picker, and that refusal is the honest
 * answer rather than a gap: an `<input>` hands over copies of bytes and there is no route from one
 * back to the folder it came from. Refusing at the ask beats handing back a handle whose every write
 * fails later.
 */
export const showDirectoryPicker: DirectoryPicker = async (options = {}) => {
  const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker
  if (picker && !framedByAnotherOrigin()) return picker(options)
  if (options.mode === 'readwrite') throw refuse(NO_WRITE_FOLDER)
  const files = await pickThroughInput((input) => {
    input.webkitdirectory = true
    input.multiple = true
  })
  return handleFor(treeFrom(files)) as FileSystemDirectoryHandle
}
