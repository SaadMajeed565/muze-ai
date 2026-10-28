# Migration: 0.2.0 -> 0.3.0

Read this before upgrading an existing install or an existing MCP client. The full list is in `CHANGELOG.md`; this is the action list.

## Extension users (upgrading in place)

- Storage keys migrate automatically: `uabb.*` keys are read as a fallback and copied to `muze.*` on first read/write. Do not delete the old keys by hand during migration.
- Policy migration changed: your stored permission gates, mode, and overrides are now preserved verbatim. If you were on a v1/v2 policy, you will **not** be silently moved to Unrestricted anymore. Check the dashboard Permissions page after upgrading and set the level you actually want.
- Dashboard messages changed to `muze/*`. Old `uabb/*` messages are still accepted inbound by the service worker, but new dashboard code emits only `muze/*`.
- Page globals changed to `__muzeObserver` / `__muzeDiagnostics` / `data-muze-ref` / `muze-sticky-style`. The controller still reads the legacy observer global as a fallback for already-open pages, and removes a legacy sticky style element. Reloading open tabs after upgrade is still recommended.
- The device token is now masked in the dashboard by default. Use the explicit reveal control (audited) to copy it, or rotate it from Overview if you suspect exposure.

## MCP clients

- Send `response_type=code` on `/authorize`. Omitting it now fails with 400.
- Do not send `confirmed`, `userApproved`, or `approved` in tool input expecting approval. Those fields were removed from unified schemas and are stripped by the gateway. Use elicitation (accept) or wait for a dashboard decision, then re-call without a flag.
- Scope matters now: a `read:tools`-only token can call read-only tools only. If your client needs writes, it needs `call:tools`.
- Server name changed to `muze-browser-gateway`. If you pin the old name, update it.
- Tool outputs gained optional fields (`method`, `dispatched`/`verified`, `errors`, `totalTables`, `partial`, `ungrouped`, `skipped`). Treat them as additive, except `navigationId`, which is now `null` instead of a fabricated UUID, and form submission, which now reports `verified:false` unless a navigation/result is observed.

## Gateway operators

- Deploy via `npm --prefix cloudflare run deploy` (builds first). `wrangler.jsonc` now points at `dist/index.js`. Bare `wrangler deploy` will ship whatever stale `dist/` exists.
- Set `EXTENSION_IDS` in production; unset disables extension sign-in.
- If you set `MCP_SHOW_ALL_TOOLS`, `GATEWAY_LABEL`, or `OPENAI_APPS_CHALLENGE`, they are now declared in `GatewayEnv` — no behaviour change, just type safety.
- Trace sampling default is now 0.1. Raise it only temporarily for debugging.
- Directory actions removed: `authorizeWithToken`, `authorizeWithPair`. Authorisation now uses the signed-in website user (`authorizeWithUser`). Pair codes remain for pairing display only and do not authorise OAuth.
- `POST /session` no longer returns a device token. Use `POST /session/rotate` (Bearer device token or signed-in website session) to rotate, or the extension sign-in handoff to obtain a token.
- WebSocket bridge clients must connect to `/bridge?session=<sessionId>` and send `{"type":"auth","token":"<device token>"}` first. A token in the URL is ignored, never authenticated, and never logged. Close codes 4401 (missing/late) and 4403 (invalid/mismatched) indicate auth failure — do not retry with the same token.

## Developers

- Run `npm run sync:contracts && npm run check:contracts` before building. The sync script now deletes stale Cloudflare contract files, and packaging refuses to run if contracts are out of sync.
- Cloudflare tests are now typechecked (`tsconfig.json` includes `test/**/*.ts`). Fix test types, not just runtime, when changing gateway code.
- Protocol version is 2.0.0 and registry version is 2.0.0. Clients that check `hello.ok` protocol/registry versions must accept 2.0.0.
- If you maintained a fork that called `tabs.zoom`, use granular `tabs.setZoom` (or the unified `tabs` action, which maps to it). If you passed `level` for zoom, `prefix` for organise, or `text`/`maxResults` for browser search at handler level, switch to the canonical forms in `CHANGELOG.md` — strict schemas now reject the old spellings at executor level.
