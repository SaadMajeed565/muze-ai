/** Version of the wire protocol spoken between the extension and bridge clients. */
export const PROTOCOL_VERSION = "2.0.0";

/**
 * Version of the tool registry schema. Bumped to 2.0.0 together with the
 * protocol version for the 0.3.0 breaking contract changes: client-supplied
 * approval flags removed from unified schemas, canonical unified parameters
 * (tabs.move / zoom / browser.search / organise strategy), unified output
 * schemas replacing z.any(), and the screenshot approval alignment.
 * Bumped to 2.1.0 for the additive Phase 0 task tools (tasks.create,
 * tasks.get, tasks.list, tasks.pause, tasks.resume, tasks.cancel); the
 * protocol version is unchanged because no existing contract changed.
 */
export const REGISTRY_VERSION = "2.3.0";
