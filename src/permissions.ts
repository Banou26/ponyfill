/**
 * `navigator.permissions`, with the same member name and one behaviour picked.
 *
 * ## The divergence
 *
 * `query()` has FOUR ways of not answering, and an app that wants a permission state has to handle
 * all of them separately even though every one means the same thing to it:
 *
 *  1. the engine has no Permissions API at all, so `navigator.permissions` is undefined
 *  2. the engine has it but rejects the name, because `PermissionName` is a per-engine list
 *  3. the engine has it and THROWS SYNCHRONOUSLY for a name it does not know, which a `.catch` on
 *     the returned promise does not see at all
 *  4. it answers, with a real `PermissionState`
 *
 * Only the fourth is the platform's documented behaviour. The other three are the same question
 * coming back unanswered in three different shapes, and the shapes are not interchangeable: case 3
 * needs a `try` around the CALL rather than a `.catch` on its result, which is the kind of detail
 * that is correct in the one file someone thought about it in and wrong everywhere else.
 *
 * ## The pick
 *
 * All three collapse to `'prompt'`.
 *
 * `'prompt'` rather than `'denied'` because an engine that cannot be asked has not refused anything,
 * and treating silence as refusal costs the person a control that might have worked. `'prompt'` is
 * also the honest description of what happens next: press the button and the browser will decide.
 *
 * WHAT THAT LOSES, stated rather than buried: after the collapse, `'prompt'` means either "the
 * browser will ask" or "the browser cannot be asked at all", and nothing distinguishes them any
 * more. That is deliberate. An app that genuinely needs to tell those apart is asking a question the
 * Permissions API does not answer either, since case 2 and case 4 are indistinguishable from a
 * rejected promise.
 *
 * NOT MEASURED, and this is the one entry in the package without a dated number behind it. What is
 * recorded upstream is the SHAPE of the failure rather than an engine and a version: a query for a
 * name an engine does not implement rejects, or throws outright. Both are handled here, and the
 * absence of a measurement is why this file says so rather than inventing one.
 */

/** The platform's own `PermissionStatus`, narrowed to the member anything actually reads. */
export type PermissionStatus = { state: PermissionState }

type PermissionsLike = {
  query: (descriptor: PermissionDescriptor) => Promise<PermissionStatus>
}

const isState = (value: unknown): value is PermissionState =>
  value === 'granted' || value === 'denied' || value === 'prompt'

export const permissions = {
  /**
   * Same name and same signature, answering `'prompt'` wherever the platform would not answer.
   *
   * The `await` is INSIDE the `try` on purpose, and it is the whole reason this is a wrapper rather
   * than a one-line `.catch`. `query` can throw synchronously for a name the engine does not know
   * and reject asynchronously for one it does, and a `.catch` on the returned promise sees only the
   * second. Getting that wrong turns a missing permission name into an uncaught exception at
   * whatever moment the feature is first used.
   */
  query: async (descriptor: PermissionDescriptor): Promise<PermissionStatus> => {
    try {
      const native = (globalThis.navigator as { permissions?: PermissionsLike } | undefined)?.permissions
      const status = await native?.query(descriptor)
      return { state: isState(status?.state) ? status.state : 'prompt' }
    } catch {
      return { state: 'prompt' }
    }
  },
}
