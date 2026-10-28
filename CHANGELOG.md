# Changelog

## 0.5.0 — task plan approval, dry-run, progress, parallel read-only, discovery v2, deprecation, health (additive, no migration needed)

Protocol version unchanged at 2.0.0, registry version 2.2.0 -> 2.3.0, product version 0.4.1 -> 0.5.0. No tool removed, no existing tool or parameter changed, no approval weakened. Old clients ignore the new metadata and tools and keep working. Registry 3.0 removal of deprecated actions is NOT enabled in this release (see Known gaps).

### Added (complex tasks, Phases 1-3)
- `tasks.approvePlan` (separate granular tool, never an action parameter, never a client flag): approve a task plan once with bounds (allowed tools/risk levels/domains, no purchases/payments/external submits unless explicitly allowed, max steps/attempts, total budget). Steps inside bounds need no second approval; steps outside pause in `waiting_approval` with the reason; denial fails only that step and the task ends `partial`, never `done`; approval expires at the task lifetime or 24 hours, whichever is shorter. MCP callers use a broker approval token (verified, bound to `tasks.approvePlan` and the calling client, then burned single-use via a new `ApprovalBroker.markUsed`); dashboard users use the dashboard decision. The executor's internal `planApproved` flag is set only by the TaskRunner after verifying an active in-bounds plan approval — it is not a tool-input field, is never forwarded from an MCP call, and policy checks still run per tool.
- `tasks.create` dry-run (`dryRun: true`): validates the whole plan (tool existence, canonical parameters, risk, domains, approvals needed, budget) and executes nothing, creating no task record. Service-worker wiring supplies registry risk/existence/parameter validation, broker-token verification, and pre-step re-observation; without those deps the runner fails closed (dry-run risk `"unknown"`, broker-token approval rejected).
- Dashboard Tasks progress and final reports: step X of Y, current step, done/failed lists, browser session, Approve plan button (confirm dialog), and a structured final report (done/undone/failed/compensations/manual cleanup) with external submits listed as done and not undoable.
- Parallel read-only steps (max 4, independent steps in one group; consequential steps only when explicitly independent and plan-approved), pre-step re-observation in the service worker (a step's dom ref must still appear in a fresh observe before consequential steps; stale ref pauses for re-observation), single-browser-session binding (a task never runs on another session, never moves browsers on its own), and gateway session-eviction pinning for sessions owning a running task (in-memory only — see Known gaps).
- Coordinator integration tests (`extension/test/integration-plan-approval.test.ts`): broker-token burn, `planApproved` satisfying the approval gate, and `planApproved` never overriding a policy denial.

### Added (tool management, Phases 2-4)
- Discovery v2: tag/category/verb/description scoring over the full registry (was keyword top-12 over unified+tasks only), permission/scope filtering first, up to 20 grouped results with full schemas for the top 5 only, prerequisites and related tools included. Real intent tags for every tool in `extension/libs/tool-contracts/tool-meta.ts` (closes the Phase 1 gap where 0 granular tools carried tags); governance test now asserts full tag coverage instead of pinning the gap.
- Session-aware ListTools: discovered and task-plan tools persist in that MCP session's ListTools until the session closes (session cache only, cleared on close, not a permission change). Task-mode tool sets at `tasks.create`. Registry-generated MCP tool-selection instructions; hand-written safety guidance kept separate.
- Deprecation warnings (not removal) for `navigate` tab/window actions and `data` devtools/clipboard domains (68 deprecated action entries): warnings in descriptions, discovery, audit, and dashboard, with use-instead names, never in the core set, still fully working.
- Dashboard Tools page: per-action risk for unified tools and per-canonical-tool health aggregates (calls, success, timeout, error, denial, latency, output size, truncated rate; no inputs/page content/screenshots), with filters and no auto-disable. Task-type recommendations and telemetry suggestions in discovery only, as suggestions, never restrictions, never replacing policy/approval.
- Generated tool inventory: `node scripts/tool-inventory.mjs` -> `TOOL-INVENTORY.md` (136 tools, 175 unified actions, 68 deprecated actions, 0 missing tags, 0 deprecated tools in core). Docs counts are now taken from it (README 136 = 116 + 13 + 7 task tools).
- `tasks.approvePlan` added to the gateway core ListTools set (it was registered and scope-checked before, but not in core).

### Fixed in integration
- Contract drift between extension and gateway copies of `discovery.ts`/`instructions.ts` (parallel-track concurrent edits) resolved by re-running `sync:contracts`; contracts check now passes with both copies identical.
- Cloudflare typecheck: 1 pre-existing unused-import error in `mcp.ts` reported by the Complex track — verified during integration (see verification note in the coordinator report).

### Known gaps after 0.5.0 (explicit, not fixed here)
- Registry 3.0 removal is NOT enabled: deprecated navigate/data actions still work. Blockers are the gateway legacy adaptation mapping granular `tabs.*`/`windows.*` back to `navigate`, and the absence of live-usage evidence (audit aggregates are in-memory/bounded, no live-browser run yet). Removal requires both, plus a migration note, before any 3.0 release.
- Session-eviction pinning is in-memory only: on Durable Object eviction pins are lost. Mitigation: a task stays bound to browser session + client id, so a re-authenticated client can call `tasks.resume`.
- Session discovered set lives in MCP server memory and is not restored on cold Durable Object rebuild (replayInitialize).
- Dashboard health covers the 50 audit events the dashboard loads, not full history; output-size/truncated recording covers new success audit events only.
- No live-browser proof: all tests are mock/jsdom plus Miniflare/fake-host. Per-action scope, plan approval, discovery v2, and task progress in a real Claude/ChatGPT client still need the live test.
- File store unchanged: still unencrypted, no per-client isolation; task records never contain file contents. Plan approval/dry-run for tasks do not change that.

## 0.4.1 — per-action risk and canonicalisation, Tool Management Phase 1 (additive, no migration needed)

Protocol version unchanged at 2.0.0, registry version 2.1.0 -> 2.2.0, product version 0.4.0 -> 0.4.1. No tool removed, no existing tool or parameter changed, no approval weakened. Old clients ignore the new action-risk metadata and keep working.

### Added
- Per-action risk table in `extension/libs/tool-contracts/action-risk.ts`: 175 entries for all 13 unified tools, each with granular target, risk, approval predicate, and side-effect class, synced to the gateway by `npm run sync:contracts`. Gateway OAuth scope is now checked against the granular risk; bridge/host approvals are fingerprinted on the granular tool + canonical input (unified name kept only as `calledAs` debug info); rate limits and audit use the canonical granular name.
- One approval-ordering fix from the unified handler audit: `act` press with Space now fails the whole `act` call before any step runs when the target is consequential, matching the existing Enter handling (previously it was blocked mid-batch by granular `dom.press`, after earlier steps had run).
- Registry governance tests (`extension/test/tool-governance.test.ts`, `cloudflare/test/action-risk-sync.test.ts`, plus the action-risk and canonical-audit suites): every unified action must resolve to an existing granular tool with matching risk, no unified entry hides a restricted real tool, no output schema is `z.any()`, tasks tools stay granular with unchanged risks.
- New-tool checklist in README, enforced by the governance test plus sync/check scripts.

### Fixed
- Unified `data` output schema typed `deleted` as a number, but granular `bookmarks.delete` returns `deleted: true`, so a successful unified bookmark delete failed output validation even though the bookmark was deleted. The unified output now accepts boolean or number.

### Known gaps after Phase 1 (explicit, not fixed here)
- Observe and act fan out to many granular tools, so gateway scope for them still uses unified risk; granular gates in the extension still apply.
- Delay waits (`wait` delay, `navigate` sync delay) have no granular tool; they are flagged restricted + approval-required in the action-risk table, but scope does not deny them, to avoid a breaking policy change. They keep pre-resolution behaviour.
- Granular tools do not yet carry tags (field exists, unused); full tag coverage is a Phase 2 discovery item, not faked here.
- No discovery v2, no session-aware ListTools, no deprecations/removals, no dashboard health aggregates, no live-browser proof.

## 0.4.0 — durable task engine, Phase 0 (additive, no migration needed)

Protocol version unchanged at 2.0.0, registry version 2.0.0 -> 2.1.0, product version 0.3.0 -> 0.4.0. No existing tool, parameter, or approval rule changed; old clients ignore the new task tools and keep working with single calls. No migration file is needed for this release.

### Added

- Durable task engine in the extension (source of truth): task model with id, goal, clientId, browserSessionId, status, ordered steps, totalBudgetMs, correlationId, and summary-only results, stored in `chrome.storage.local` under `muze.tasks` (100 steps per task, 50 stored tasks, completed tasks pruned after 7 days unless pinned).
- Six new MCP tools, additive only: `tasks.create`, `tasks.get`, `tasks.list`, `tasks.pause`, `tasks.resume`, `tasks.cancel`. Task tools are merged into TOOL_SCHEMAS; their executor handlers are stubs that throw UNSUPPORTED, so tasks must go through host dispatch to the runner and can never bypass the runner's checkpoint, idempotency, or policy re-checks.
- Sequential runner with checkpoint after every step (record, persist, audit, progress, then next step), resume from storage after a simulated service-worker restart, and honest endings (`done`, `failed`, `cancelled`, `partial`) with done/undone lists and best-effort compensations.
- Idempotency per step (SHA-256 key from task id, step index, and canonical input): a done consequential step is never re-executed on resume or duplicate retry.
- Unknown-step handling on bridge disconnect: a step whose effect is unknown is marked `unknown` and paused as `bridge-disconnected`, then re-observed before any retry (navigation confirmed by URL match, read-only steps safe to re-execute, unconfirmable consequential steps pause for manual check, never blindly retried).
- Per-tab serialisation for consequential steps (per-tab promise chains, same pattern as capture/injection locks) and pinned-tab pauses (`tab-closed`, `tab-navigated-externally`).
- Rate-limit / fail-closed pause: 429/503 and `RATE_LIMITED` pause the task with `resumeAfterMs` backoff, step stays pending, attempts not charged, no retry loop.
- Policy/client/scope re-check at every step: policy version and mode recorded at creation, re-checked per step, pause on change; resume only by the same client (bridge client id, not name) with same or stricter scope, never by a different or weaker client. OAuth scope itself is enforced at the gateway (read-only scope may only get/list; create/pause/resume/cancel require `call:tools`) and recorded in the extension snapshot as `gateway-enforced`, because scope is not forwarded over the bridge.
- Per-step `timeoutMs` (1–60000, default 30000, validated against the 60-second bridge cap) and a task-level total budget (default 600000 ms, pause on `budget-exceeded`).
- Gateway task status mirror only (status, step index, total steps, browser session id, updatedAt — never goal, inputs, or outputs), persisted under `mcp:tasks` and exposed on the existing `/session/status` route; the gateway never executes a step or synthesises a task view.
- Dashboard Tasks page (progress, step X of Y, done/undone lists, pause/resume/cancel with confirm on cancel, 5-second polling only while the page is open) and `muze/tasks.*` dashboard messages, with sanitised views only (no step inputs, tokens, page content, or screenshots). New bridge event kind `task.progress` (additive, protocol version unchanged).
- Integration tests a–g: restart resume, idempotency, bridge-disconnect re-observe, pinned-tab pauses, rate-limit pause, policy/client/scope guards, and cancel reporting, plus host-dispatch and dashboard-handler wiring tests.

### Deliberately left (with risk, see SECURITY.md)

- No plan-level approval (`tasks.approvePlan`) and no dry-run yet — those are Phase 1. Every consequential step still needs its own approval through the existing flow.
- No parallel steps yet — sequential only.
- No durable audit export yet — task audit entries are mapped into the in-memory audit log; task state itself is durable, approvals and audit history are not.
- No live-browser proof yet — tests remain mock/jsdom plus Miniflare/fake-host, as in 0.3.0. CDP, capture, and click-through still need live proof.
- File store is still not encrypted and has no per-client isolation (unchanged from 0.3.0); task records never contain file contents, but files collected by a task share the existing file store.

## 0.3.0 — production/enterprise pass (breaking)

Protocol version 1.0.0 -> 2.0.0, registry version 1.2.0 -> 2.0.0, product version 0.2.0 -> 0.3.0.

### Breaking changes (see MIGRATION.md)

- Client-supplied confirmation flags (`confirmed`, `userApproved`, `approved`) are removed from unified schemas, stripped at the gateway and bridge, and never count as approval. Clients that relied on them will now get approval-required errors.
- Internal prefix `uabb` -> `muze` for dashboard message types, storage keys, server names, page globals, and gateway client headers. Legacy dashboard messages and storage keys are accepted/migrated on read (extension side); gateway internal headers (`x-muze-client-*`) have no legacy fallback.
- MCP server name `uabb-browser-gateway` -> `muze-browser-gateway`; bridge client id `uabb-gateway` -> `muze-gateway`.
- WebSocket bridge auth: no token in the URL. Connect to `/bridge?session=<sessionId>` and send `{"type":"auth","token":"<device token>"}` as the first message (close 4401/4403 on failure).
- OAuth: `response_type=code` is now required on `/authorize`; token-paste authorisation is removed (signed-in website user authorises); `authorizeWithToken` and `authorizeWithPair` directory actions are removed; `POST /session` no longer returns a device token.
- Navigation ids are now `null` (the browser API returns no navigation id; 0.2.0 fabricated a UUID).
- Form submission results now report `dispatched` and `verified:false` instead of asserting verified submission.
- Element refs are now strictly stale after re-render: re-resolution by stored find query was removed.
- Unified `tabs`/`windows` risk changed read-only -> reversible; unified `clipboard` approval false -> true; `screenshots.fullPage` and `browser.captureTab` approval false -> true.
- Rate-limiter failures are now fail-closed (503) everywhere on the gateway, including the previously fail-open error path.
- Wrangler deploys `dist/index.js` (built first), not `src/index.ts`. Trace sampling default is 0.1, not 1.

### Naming and params

- Canonical params enforced in schemas and handlers: `tabs.move {tabIds, windowId?, index?}`, `tabs.zoom` via granular `tabs.setZoom {tabId, zoom}`, `browser.search {query, limit?, includeHistory?, includeBookmarks?, includeTabs?}`, navigate organise strategy `domain | titlePrefix`, act scroll direction/amount vs x/y vs scroll-into-view as distinct paths, form/submit file caps matching granular (upload 15,000,000 base64 chars, setFile 35,000,000 base64 chars, with character-stated errors).
- Bounds added for coordinates (0–100000, viewport-checked in handlers), array/text lengths, file sizes, pagination, and timeouts. Unknown providers, actions, and enums are rejected, not silently fallen back to.
- Tool counts are derived from the registry everywhere; the hardcoded "112 tools" copy is gone.
- Dead code removed: logo SVG path, unused RiskBadge and danger button variant, duplicate 1100px media query, DirectoryDO dead actions, legacy-tools parameter, and others listed in section reports. Contract sync now deletes stale Cloudflare files; packaging now runs sync + check first.

### Accuracy

- Fixed: restricted-URL leak in tab listings (URL now omitted for restricted URLs); page networkIdle stale snapshot (fresh state every poll); page-agent double click (single dispatch); stale-ref re-resolution (fail stale); browser.search silent source narrowing (per-source errors reported); navigation.search silent provider fallback (unknown provider rejected); inconsistent sensitive-field guards (handler-level check covering type/name/id/label/autocomplete, plus snapshot/a11y redaction); registrable-domain approximation (expanded suffix list + ccSLD heuristic, still documented as approximate); form submission asserted-not-verified (see breaking changes); output truncation now reports `truncated`, `totalChars`, `preview`, and `screenshotOmitted` instead of silently replacing a result.
- Observe: one failed include no longer fails the whole call; per-include errors are reported.
- Workflows: openSequence, mapPool, compareTabs, collectLinks, researchReport, extractTable (now with `tableIndex` and `totalTables`), organizeTabs (now reports `ungrouped`/`skipped`), saveSession/restoreSession (now report `skipped` and partial results) all return partial results instead of losing them.

### Speed

- Executor runtime snapshot is cached per client and invalidated by `PolicyEngine.getVersion()` (incremented on every policy mutation), instead of rebuilding the full allowed/denied list on every call.
- Nested invokes no longer take a second rate-limit token (code now matches its documented behaviour).
- Gateway tool listing is cached for 5 seconds per MCP server instance; a failed live fetch returns a fresh cached list instead of immediately advertising nothing.
- Capture waits are now named constants with real completion signals where available (tab-complete poll for background-tab capture, capped); full-page slice waits remain 120ms and are now a named constant.

### Complex tasks

- Unified schemas tightened: no `z.any()` outputs remain in tool-contracts; structured outputs, real caps, real enums, and explicit scroll/file/disambiguation rules.
- Legacy tool mapping is explicit about dropped fields and about which paths are lossy; unknown names still pass through to a not-found error at the extension, documented as such.
- Long act/form/workflow sequences are partial-result friendly (see Accuracy) and report per-step/per-item errors.
- Multi-frame handling is explicit: CDP fast paths are top-frame only, synthetic fallback is recorded as `method:"synthetic"`, and other CDP failures are thrown, not silently caught. FrameId/ref contradictions fail explicitly.

### Enterprise hardening

- OAuth scope enforcement on tool calls (see README).
- Device-token rotation endpoint (`POST /session/rotate`, Bearer or signed-in website session, old token invalidated immediately, same session id); token removed from WebSocket URLs and from dashboard state (masked display only, explicit audited reveal); account page shows masked token only.
- Account deletion purges persisted MCP session records in SessionDO.
- Dashboard wait for approvals: 2 seconds -> 120 seconds (matching broker TTL).
- Dashboard fixes: 5-column tab grid for 5 tabs, clamped onboarding steps, approvals grouped by client id, confirmations for privileged actions, sign-out and rotate-token controls, approval countdowns ticking on their own timer, audit kinds for token reveal/rotate, dedicated `preflight-unavailable` audit decision.
- Old-install policy migration no longer silently moves users to unrestricted or drops gates; stored gates are preserved verbatim, missing fields are filled from defaults, and a mode-less old policy lands on default, never unrestricted.
- Gateway: response_type validation, client version header restored (sanitised, max 120 chars), parseCookies no longer throws on malformed input, all env vars declared in `GatewayEnv`, Cloudflare tests included in typechecking, build/deploy mismatch fixed, extension `--watch` now genuinely watches bundles.
- Structured, secret-free logging and request ids on gateway error responses; audit details remain reason/code only.

### Deliberately left (with risk, see SECURITY.md)

- File store is not encrypted and has no per-client isolation.
- Registrable-domain detection is still an approximation, not a full public-suffix list.
- Unified `data` remains risk `reversible` even though it can route to delete/write actions; those sub-actions are still gated by their granular consequential gates on nested execution, and the description states that. A future multi-category risk model could label it more precisely.
- `authorizeWithToken` was removed outright (not kept for compat); any external caller that used that directory action directly (not via a Worker route) will get `unknown action`.
- Live-browser proof for CDP concurrency, capture, and click-through is still outstanding; tests remain mock/jsdom + Miniflare/fake-host.
