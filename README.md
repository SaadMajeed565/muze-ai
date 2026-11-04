# Muze AI — 0.5.0

Muze AI connects a user's Chrome browser to AI clients (for example Claude) over MCP, with the browser itself as the permission authority.

Two projects live in this repo:

- `extension/` — a Chrome Manifest V3 extension. Its service worker owns the tool registry, policy engine, approval broker, audit log, and rate limiter, and executes tool calls against real Chrome APIs. A Preact dashboard (side panel and options page) shows state, approvals, permissions, files, and activity across five tabs (Home, Tasks, Connections, Files, Account). There is no Tools page: per-action risk and tool health are not rendered in the dashboard.
- `cloudflare/` — a Cloudflare Worker gateway with Durable Objects. It owns website accounts, OAuth for MCP clients, device-token pairing, session routing, and the MCP server. It never executes browser actions itself; it authenticates, routes, rate-limits, and relays to the extension over a WebSocket bridge.

```
AI client -> Worker /mcp (OAuth) -> Session Durable Object
  -> WebSocket /bridge (first-message auth) -> extension service worker
  -> ToolExecutor (policy + approval + audit) -> Chrome / page agent / CDP / observer
```

## Tool surface

The registry is the single source of truth. Tool counts are derived from it at runtime and in tests — never hardcode a count in UI copy.

- 138 tools in 0.5.0: 118 granular tools plus 13 unified tools plus 7 task tools (`tasks.create`, `tasks.complete`, `tasks.get`, `tasks.list`, `tasks.pause`, `tasks.resume`, `tasks.cancel`). Tool counts are generated from the registry by `node scripts/tool-inventory.mjs` (`TOOL-INVENTORY.md`) — never hardcode a count in UI copy.
- The MCP surface by default shows 5 master tools (observe, act, navigate, form, data) plus batch and discover, plus the 7 task tools in the core set. Other tools are discoverable through `tools.discover`, or shown in full when `MCP_SHOW_ALL_TOOLS` is set.
- Risk tiers: read-only, reversible, sensitive-read, consequential, restricted. No tool currently uses the restricted tier; the tier exists as a deny-by-default gate.
- Batch calls on the extension side are limited to read-only tools.

## Per-action risk and canonicalisation (0.4.1, Tool Management Phase 1)

Unified tools are a facade: every unified action resolves to a granular
tool before scope, policy, approval, rate limiting, or audit. The table
lives in `extension/libs/tool-contracts/action-risk.ts` (179 entries for
the 13 unified tools) and is synced to the gateway by
`npm run sync:contracts`. Gateway OAuth scope is checked against the
granular risk, so a `read:tools` client can call `tabs.list` through
unified but not `tabs.close`. Approvals are fingerprinted on the granular
tool + canonical input, with the unified name kept only as `calledAs`
debug info. Rate limits and audit use the canonical granular name, so
`navigate.close`, `tabs.close`, and granular `tabs.close` all audit as
`tabs.close`. Tasks tools stay granular and are not unified. One
pre-existing bug fixed in this release: unified `data` output typed
`deleted` as a number, but granular `bookmarks.delete` returns
`deleted: true`, so a successful unified bookmark delete failed output
validation; the unified output now accepts boolean or number.

### Adding a new tool — checklist (enforced by tests + sync/check)

- Strict zod input and output schemas, no `z.any()` outputs.
- Every file cap and coordinate cap stated in the schema, not only
  in the handler (form upload 15,000,000 / setFile 35,000,000 base64
  characters, coordinates 0–100,000).
- Risk per action, not just per tool: add an entry to the action-risk
  table for every new unified action, with granular target, risk,
  approval predicate, and side-effect class.
- Approval predicate: state whether the action needs approval, defers
  to the granular handler (`'granular'` only for conditional
  activation checks), or needs none — and add a test for approval
  denial, not just success.
- Tags, prerequisites, related tools, and a when-not-to-use line
  (every tool carries real intent tags in
  `extension/libs/tool-contracts/tool-meta.ts`, used by discovery v2;
  the governance test asserts full tag coverage).
- Tests for success, failure, and approval denial; dashboard entry
  if the tool is user-visible; run `npm run sync:contracts` and
  `npm run check:contracts` so both contract copies stay identical.
  CI for this checklist is the vitest governance test
  (`extension/test/tool-governance.test.ts`) plus sync/check scripts.


## Durable tasks: dry-run, progress, parallel read-only (0.5.0)

- There is no separate step for approving a plan: a task's plan runs straight into
  the loop, and every consequential step goes through the normal
  per-step executor, policy, and approval gates at execution time —
  creating a task never pre-approves its steps, and a client-supplied
  confirmation flag is still never approval. Plan bounds supplied at
  creation are data for dry-run previews only. A step that needs
  approval pauses in `waiting_approval` until it is granted through
  the existing step-approval flow (elicitation dialog or dashboard
  decision); a denied step ends the task `partial` (or `failed` when
  nothing succeeded), never `done`.
- `tasks.create` with `dryRun: true` validates the whole plan (tool
  existence, canonical parameters, risk, domains, approvals needed,
  budget) and executes nothing, creating no task record.
- Dashboard Tasks page shows progress (step X of Y), current step,
  done/failed lists, browser session, and a structured final report
  (done/undone/failed/compensations/manual cleanup); external submits
  are listed as done and not undoable, never as compensated.
- Parallel steps: read-only, independent steps in one group run
  together, max 4; consequential steps never join a batch and run
  sequentially through per-step approval. Pre-step re-observation in the
  service worker checks a step's dom ref against a fresh observe
  before consequential steps; a stale ref pauses the task for
  re-observation instead of failing it. Tasks are bound to one
  browser session id and never move browsers on their own; gateway
  session-eviction pinning for sessions owning a running task is
  in-memory only, so on Durable Object eviction pins are lost and
  the mitigation is re-authentication + `tasks.resume` against the
  same browser session and client id.

## Smart tool management: discovery v2, deprecation, health (0.5.0)

- Discovery v2 (`tools.discover`) scores by exact name, tag, category,
  action verb, then description over the full registry, filtered by
  permission/scope first, up to 20 grouped results with full schemas
  for the top 5 only, plus prerequisites and related tools.
  Discovered and task-plan tools persist in that MCP session's
  ListTools until the session closes (session cache only, cleared
  on close, not a permission change). ListTools caps are Muze's own
  conservative documented caps (50 ListTools, 20 discovery, top-5
  schemas) — no Claude/ChatGPT vendor limit is asserted.
- MCP tool-selection instructions are now generated from the
  registry (`extension/libs/tool-contracts/instructions.ts`); only
  the hand-written safety guidance stays hand-written.
- Deprecated in 2.x, still working, removal reserved for registry
  3.0 pending live-usage evidence: `navigate` tab/window actions
  (use `tabs.*`/`windows.*`) and `data` devtools/clipboard domains
  (use `devtools.*`/`clipboard.*`), with warnings in descriptions,
  discovery, audit, and dashboard. The gateway's legacy adaptation
  that maps granular `tabs.*`/`windows.*` back to `navigate` is a
  blocker for removal and must be removed first, with live-usage
  evidence, before any 3.0 removal.
- The dashboard has no Tools page (five tabs: Home, Tasks, Connections, Files, Account); per-action risk for unified tools lives in `extension/libs/tool-contracts/action-risk.ts` and is used by scope, approval, and discovery, not rendered as a dashboard page.
  Task-type recommendations and telemetry suggestions appear in
  discovery only, as suggestions, never restrictions, never
  replacing policy or approval.

Unified and granular tools agree on parameter names, types, enums, and bounds in 0.3.0. See `CHANGELOG.md` for the canonical forms (tabs.move, tabs.zoom, browser.search, act scroll, navigate organise strategy, form/submit file caps).

## Approval model — read this first

Only three things can approve a call:

1. A broker approval token, consumed once and bound to the exact tool, input, and client.
2. A dashboard decision (approve/deny in the extension dashboard).
3. A verified elicitation decision from an MCP client.

A confirmation flag in tool input (`confirmed`, `userApproved`, `approved`) is **never** approval. Those fields were removed from unified schemas in 0.3.0, are stripped at the gateway and at the bridge boundary, and are ignored by the executor. A client that sends one expecting approval will get an approval-required error instead.

Dashboard approval waits up to 120 seconds (matching the broker TTL). MCP clients may time out earlier on their own side; that approves or denies nothing.

OAuth scopes are enforced on tool calls before forwarding to the bridge: a token with only `read:tools` may call read-only tools only; `call:tools` is required for reversible, sensitive-read, and consequential tools. Missing, empty, or unknown scope is denied. A restricted-risk tool is denied for every scope.

## Pairing and sign-in

1. Create an account on the gateway website (passwords are PBKDF2-hashed, 50,000 iterations).
2. In the extension dashboard, sign in. The extension exchanges a short-lived code (60 seconds) for a device token, stored in `chrome.storage.local`.
3. The extension opens a WebSocket to `/bridge?session=<sessionId>` with **no token in the URL**, then sends `{"type":"auth","token":"<device token>"}` as its first message. The Session Durable Object verifies it against the directory and closes the socket with 4401 (missing/late) or 4403 (invalid/mismatched) on failure.
4. An MCP client registers as a public OAuth client (S256 PKCE only, `response_type=code` required), and the signed-in website user authorises it on the authorize page. No device token is pasted into that form in 0.3.0.
5. The client calls `/mcp` with its OAuth access token (1 hour; refresh tokens rotate once, 30 days).

Device tokens are long-lived by design for a paired browser, so they can be rotated: website account page Rotate button, or `POST /session/rotate` with a Bearer <redacted> token or a signed-in website session. Rotation invalidates the old token immediately and keeps the same session id. No token value reaches the dashboard at all — not even masked: the masked display, Reveal/Copy buttons, the `muze/gateway/token` reveal route, the `tokenMasked` dashboard field, and the `token.reveal` audit kind were all deleted in 0.5.0. The token still lives in extension storage for bridge authentication.

## Build, test, deploy

Requires Node `^22.12.0 || >=24.0.0`.

```sh
npm run install:all          # install extension + gateway deps
npm run sync:contracts       # copy extension tool-contracts to cloudflare/
npm run check:contracts      # fail if the two copies differ or have extras
npm run typecheck            # tsc --noEmit for both projects (tests included)
npm test                     # vitest for cloudflare, then extension
npm run build                # sync contracts, build gateway, build extension
npm run package:extension    # sync + check + build + zip to release/
```

Extension alone: `npm --prefix extension run build` (or `--watch`, which now genuinely watches bundles; static files still need a re-run). Gateway alone: `npm --prefix cloudflare run build`, then `npm --prefix cloudflare run deploy` — deploy builds first, because `wrangler.jsonc` points at `dist/index.js`, not at `src/index.ts`. Do not run bare `wrangler deploy` or it will ship whatever stale `dist/` happens to exist.

## Gateway environment variables

Declared in `cloudflare/src/config.ts`:

- `EXTENSION_IDS` — comma-separated extension ids allowed for sign-in handoff and CORS. Required in production; unset disables extension sign-in.
- `GATEWAY_LABEL` — human-readable deployment name for pairing UI (declared; currently unused by gateway code).
- `OPENAI_APPS_CHALLENGE` — verbatim challenge token served at `/.well-known/openai-apps-challenge`, or 404 if unset.
- `MCP_SHOW_ALL_TOOLS` — `1`/`true`/`yes`/`on` shows the full tool registry to MCP clients instead of the curated core set.

Wrangler observability head sampling is 0.1 (10%) by default in `wrangler.jsonc`; raise it temporarily for debugging, then restore it.

## Dashboard controls

Permission levels: Restricted (read-only only), Balanced/default (read/reversible run, sensitive/consequential ask), Unrestricted (everything runs without a prompt — only on machines you trust). Per-tool overrides survive level changes. Safety controls: approval prompts, read-only mode, and an emergency stop (kill switch) that refuses every tool call until turned off. Privileged dashboard actions (switching to Unrestricted, toggling the kill switch, resetting overrides, removing a file, cancelling a client's approvals, rotating the token, signing out) ask for confirmation.

## Durable tasks (0.4.0, Phase 0)

A task is a durable multi-step job owned by the extension, not by the MCP client's conversation. Create one with `tasks.create` (goal plus ordered steps, each step naming an existing tool and its input), poll it with `tasks.get` / `tasks.list`, and pause, resume, or cancel it. The runner executes steps sequentially through the existing executor, policy, and approval gates — creating a task never pre-approves its steps, and a client-supplied confirmation flag is still never approval.

- State lives in `chrome.storage.local` under `muze.tasks`, checkpointed after every step (record result, persist, audit, emit progress, then next step), so a task survives a service-worker restart and resumes from its last checkpoint with no duplicate consequential step (idempotency key per step).
- Caps: 100 steps per task, 50 stored tasks, completed tasks pruned after 7 days unless pinned. Task records carry summaries only — never step inputs, full page content, screenshots, passwords, tokens, or file contents.
- Safety pauses, never silent failures: pinned tab closed or navigated externally, rate limit (429/503, with `resumeAfterMs` backoff), policy version/mode change, different client, or weaker scope on resume, and bridge disconnect (step marked `unknown`, re-observed before any retry, never blindly retried).
- Honest endings only: `done`, `failed`, `cancelled`, or `partial`, always with done and undone step lists and best-effort compensations (external submits are reported as done and not undoable, never claimed as rolled back).
- The gateway only mirrors task status (status-only, from `tasks.*` results, exposed on `/session/status`); it never executes a step and never synthesises a task view. The dashboard Tasks page shows progress (polling every 5 seconds while open) and pause/resume/cancel, with sanitised views only.
- Not yet built (Phase 1/2, as of the 0.4.0 section this list sits in — see the 0.5.0 section above, where dry-run and parallel read-only steps are built; durable audit export is still not built): dry-run, parallel steps, and durable audit export. A task still cannot undo an external submit, cannot make a slow page fast, and cannot survive a client turn limit on its own — but it can be resumed in a later turn with `tasks.resume`, because the task now lives in the extension.
- Known task limits, stated plainly: OAuth scope is enforced at the gateway, not forwarded over the bridge, so the extension task snapshot records scope as `gateway-enforced` and enforces client identity, policy version, and mode; per-client task isolation therefore relies on the gateway's verified OAuth client id (host dispatch uses bridge client id, not name). Direct executor calls to `tasks.*` fail with UNSUPPORTED — tasks must go through host dispatch to the runner.

## Known limitations (honest, not fixed by 0.4.0)

- The file store (`chrome.storage.local` via IndexedDB) is not encrypted and has no per-client isolation. Anyone who can call the file tools or guess a file id can reference that file.
- Registrable-domain detection is an approximation (expanded suffix list plus a ccSLD heuristic), not a full public-suffix list. It affects blocked-domain matching and tab grouping, not authentication.
- The page observer runs in the page's MAIN world when enabled, and answers dialogs with a sticky default (labelled as sticky, not per-dialog). Disabling it is now pushed into already-open tabs, but a page script can in principle detect it.
- CDP trusted input is product behaviour: it dispatches trusted events that synthetic events cannot. Tabs are detached after each CDP sequence (reference-counted for concurrent calls), but live multi-call concurrency still needs real-browser proof.
- Tests are mock/jsdom for the extension and Miniflare plus a fake host for the gateway end-to-end test. They prove plumbing, policy, and contracts — not real-browser execution, which still needs live proof for CDP, capture, and click-through paths.
- See `SECURITY.md` for the full threat model and `MIGRATION.md` before upgrading from 0.2.0.
