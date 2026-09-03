# @banou/ponyfill

Ponyfills for the places browsers disagree, with the measurement behind each one.

```ts
import { storage } from '@banou/ponyfill'

const { usage, quota } = await storage.estimate()
```

## Why this is a package and not a file in an app

**It is a ponyfill, never a polyfill.** Nothing here writes to a global. You import the wrapped API
and call the same method names the platform uses, so a call site reads the same as the native one and
`grep` can still find every place that needed the workaround.

Patching `navigator.storage` would change what every other script on the page sees, including code
that was correct against the real behaviour, and it would hide the difference at exactly the call
sites that most need to show it.

**Every workaround carries its measurement.** What was measured, on what, and when. A workaround with
no measurement behind it is a guess that outlives the bug it was written for, and there is no way to
tell the two apart later.

## What is in it

### `storage`

The same method names as `navigator.storage`, fixing two things.

**`usage` can be six orders of magnitude short.** Measured on Chrome 151: an origin holding a
verified 1,783,407,077 bytes reported `usage: 1,813,502` with `usageDetails.fileSystem: 752`. 752
bytes against 1.78 GB. Anything sizing a write from that decides everything fits, then fails with
`QuotaExceededError` at the real limit. `storage.estimate()` walks the origin and reports the larger
of the two, keeping the parts the browser counts correctly (IndexedDB, caches) rather than replacing
them.

**`quota` means a different thing on each engine.** Measured 2026-09-03, one machine with 2.7 TiB
free, one origin, three 512 MiB sparse writes per engine, same page and same code:

| engine | quota at rest | after 1.615 GB written | `quota - usage` |
| --- | --- | --- | --- |
| Chromium 152 | 10,737,491,968 | rose by exactly what was written | 10,737,418,240 every time, moved **0 bytes** |
| Firefox | 10,737,418,240 | unmoved | fell 536,870,912 per write |

Both cap at 10 GiB; they cap **different quantities**. Chromium's quota is a floating ceiling
(`usage + headroom`), so the headroom is a constant and can never shrink. Firefox's is a fixed
ceiling, so writing consumes it.

Neither is a bug: the Storage Standard calls quota "a conservative estimate" and never says how to
compute it. But it means this very common line is dead on one engine and live on the other:

```ts
if (quota - usage < someFloor) { /* ... */ }   // can never be true on Chromium
```

That is not hypothetical. It is why four of ripple's storage eviction tests sat failing for months:
they filled the origin to provoke that condition, and 3.5 GB of padding left the free figure
identical to the byte.

**The behaviour picked is Firefox's: a ceiling does not rise because you put something under it.**
`quota` is reported as the lowest the platform has stated for this origin, which needs no probe and
no user agent sniffing, and invents nothing: the platform really did say the origin could hold that
much. Two ordinary things are broken by the rising version, and both were seen in ripple:
`usage / quota` as a gauge never fills, and `quota - usage < floor` never fires, so nothing can
detect pressure at all.

The cost is deliberate and in the safe direction. On Chromium, once bytes are written the reported
headroom is smaller than what could really be written, so a caller reclaims cache slightly early.
Cache is the thing that can be fetched again; a caller that never reclaims because it never sees
pressure is the failure this replaces. The ceiling still follows the platform DOWNWARD, and is never
reported below the bytes already held, so `quota - usage` reaches zero and never goes negative.

The ceiling is held per realm and in memory, and it **lets go when the origin's persistence changes**.
A granted `persist()` moved the reported quota from 12 GB to 3.97 TB on Firefox (measured
2026-09-01), so the figure learned before that is worse than useless afterwards. The release is keyed
on the state rather than on the call, because `persist()` only exists on the main thread: a worker
that latched the old ceiling and could never call it would go on deciding what to delete from a
number that no longer exists.

### `permissions`

`query()` has four ways of behaving and only one of them is an answer: the engine may have no
Permissions API, may reject a name it does not implement, may **throw synchronously** for one (which
a `.catch` on the returned promise never sees), or may answer a real state.

All three non-answers collapse to `'prompt'`. Not `'denied'`, because an engine that cannot be asked
has not refused anything, and treating silence as refusal costs the person a control that might have
worked.

### `showOpenFilePicker`, `showDirectoryPicker`, `showSaveFilePicker`

Measured 2026-09-03 across Chromium 149, Firefox 151 and WebKit 26:

| | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| the three pickers | present | **absent** | **absent** |
| `FileSystemHandle` and friends as globals | present | present | **absent** |
| `<input>.webkitdirectory` and its `cancel` event | yes | yes | yes |
| an object holding its methods as own properties, cloned | `DataCloneError` | `DataCloneError` | `DataCloneError` |
| the same object with its methods on a prototype | clones, silently | clones, silently | clones, silently |
| `<input webkitdirectory>` file order, same tree | `a`, `sub/b` | `sub/b`, `a` | `sub/b`, `a` |

**Reading always works, and always answers handles.** Where the platform has a picker it is used and
its handles come back untouched. Where it does not, an `<input type="file">` is opened and what comes
back is wrapped in the same shape, so a caller has one call and one return type instead of a
`FileSystemFileHandle | File` union threaded through everything downstream.

**Writing is refused rather than faked.** `showSaveFilePicker` has no fallback, `showDirectoryPicker`
refuses `mode: 'readwrite'` where there is no native picker, and a wrapped handle's
`createWritable()` throws. There is no way to write to a chosen location without the platform's
picker.

**Refusals happen before the gesture is spent**, and are named `NotAllowedError` so a caller can tell
them from the `AbortError` the platform throws when the person cancels. A caller has one transient
activation, and a picker that rejects at call time has already spent part of it.

**A wrapped handle cannot be persisted, and says so loudly.** This is the one difference that cannot
be absorbed, so what is picked is how it fails. A native handle survives `structuredClone` and comes
back out of IndexedDB still usable; a wrapper around a `File` cannot, because a snapshot is not an
entry on a disk. Left as an ordinary object it would clone *successfully* and come back with its
prototype gone and every method with it, failing after a reload with nothing pointing at the pick. So
every wrapped handle carries its methods as own properties, which makes the store throw
`DataCloneError` at the moment of the mistake: one `.catch` where it matters instead of a capability
probe at every call site.

## Adding to it

If you hit something that behaves differently between engines, or differently from its own
specification, it goes here rather than into the app that found it. State what you measured, on what,
and when, and pin it with a test that fails when the workaround is removed.
