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

This package does **not** invent a normalised quota, and does not add API for the difference either:
on Chromium you really can write 10 more GiB, so the native answer is true, and there is no platform
name for "which shape is this". It is written down here and in the source because the two are
indistinguishable at rest, which is how the difference went unnoticed for months.

## Adding to it

If you hit something that behaves differently between engines, or differently from its own
specification, it goes here rather than into the app that found it. State what you measured, on what,
and when, and pin it with a test that fails when the workaround is removed.
