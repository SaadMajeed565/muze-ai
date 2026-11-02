# Muze AI — Smart tool management plan: fix unified tools, then manage them intelligently

Version: Muze AI 0.4.0, registry 2.1.0, 135 tools (116 granular + 13 unified + 6 tasks)
Status: plan only, nothing built yet.

> SUPERSEDED (0.4.1/0.5.0): this plan's phases have since been built — the registry is now 136 tools (116 granular + 13 unified + 7 tasks, tasks.approvePlan included), the per-action risk table is 179 entries, and discovery/deprecation are implemented. Read CHANGELOG.md 0.4.1/0.5.0 for the built state; this document is retained as the original plan, not as a description of the current code. This plan follows the unified-tools
verdict in the previous turn: unified as a client-facing layer is right,
unified risk as the only gate is wrong, and tasks tools must stay granular.

## 1. What "smart" means here, in one sentence

A tool should be chosen by what it actually does, not by what its
group label says, and the system should show the client only the tools
it needs, in the right order, with the right risk, approval, and cost
attached to each action.

Today, three things stop that:

1. Risk, scope, approval, rate limiting, and audit are attached to
   the unified tool name, not to the action inside it. `tabs` is
   reversible, whether it lists tabs or closes a session. `data` is
   reversible, whether it lists bookmarks or deletes history.
2. Discovery is keyword search, top 12, by name, title, and
   description only. It does not know categories, tags, prerequisites,
   related tools, permission level, or what the client already
   discovered in this session.
3. The registry is code scattered across schema files, not data the
   system can reason about. There is no per-tool health, no cost or
   context weight, no deprecation lifecycle, and no generated client
   guidance. The dashboard Tools page shows allowed versus denied,
   not whether a tool is slow, error-prone, or misused.

Smart management fixes those three, in that order. Safety first,
discovery second, cleanup third. Do not build adaptive recommendations
before per-action safety exists, or the system will recommend a
dangerous action faster.

## 2. The new model: one registry, three layers

Keep the architecture that already works: granular tools are the
execution truth, unified tools are a facade that dispatches to them.
Add a management layer between MCP and execution, so every call is
resolved, authorised, and logged at the granular level, no matter
which name the client used.

```
Client call (unified or granular)
  -> Tool Manager: resolve
       alias -> canonical name
       unified action -> granular tool + canonical input
  -> Tool Manager: authorise per action
       OAuth scope for the granular risk
       policy for the granular tool
       approval predicate for the granular action
       rate limit per granular tool, not per unified name
  -> Executor: run granular tool
  -> Tool Manager: audit canonical name, action, risk, decision,
       latency, output size, truncated flag
  -> Client: granular result, with the canonical tool named in
       the audit and in any error, so the client learns the
       precise name for next time
```

No new execution logic is needed for most tools. The manager is a
resolution and authorisation layer, not a second executor.

### 2.1 Tool metadata — every tool, granular and unified, gets this

Extend ToolDescriptor, additively, so old clients ignore new fields:

- `canonicalTarget`: for a unified action, the granular tool it
  dispatches to. For a granular tool, itself.
- `actionRisk`: a table, for unified tools only, mapping each action
  to its risk and approval predicate. Example for `tabs`:
  list, get, active, search = read-only, no approval;
  create, activate, duplicate, discard, move, pin, mute, zoom,
  group, ungroup = reversible, policy gate only;
  close = reversible, policy gate only, but with a warning that
  it is destructive to that tab's content;
  save_session, restore_session, organise = consequential,
  approval required through the granular workflow gate.
  Example for `data`: list, search = read-only or sensitive-read
  depending on domain; create, move, update = reversible;
  delete, erase, clipboard read, clipboard write, dialog respond
  = consequential or sensitive-read, approval required.
- `sideEffects`: none, browser-state, external-visible, or
  destructive, separate from risk, so a reversible close is not
  confused with a reversible scroll.
- `idempotent`: true, false, or conditional, with the condition
  stated, for example a read is idempotent, a click is not.
- `cost`: context weight (input schema size in tokens, estimated),
  typical latency class (fast, medium, slow), and output size class.
  Used for context budgeting, not for billing.
- `tags`: intent tags, for example read, navigate, organise, fill,
  submit, capture, search, organise-tabs, collect. Tags are the
  discovery index, not free text in the description.
- `requires`: prerequisites, for example `act` requires an `observe`
  first for a ref, `form.submit` requires `form.preview` first,
  `tasks.resume` requires a task id from `tasks.create` or `tasks.list`.
- `related`: tools that are often needed next, for example after
  `observe` suggest `act` and `tools.batch` for reads.
- `whenNotToUse`: one line per tool, for example do not use
  `navigate` tab actions, use `tabs` instead; do not use `data`
  for clipboard, use `clipboard` instead, after deprecation.
- `deprecated`, `aliasFor`, `removedIn`: deprecation lifecycle,
  see section 5.

Granular tools already have category, risk, requiresApproval as a
boolean or a predicate, hostPermissions, and targetsActiveTab. Keep
those. The new fields are for unified actions and for management,
not a replacement for granular risk.

### 2.2 Canonicalisation — the single most important fix

Today, a unified call is audited, rate limited, and approved under
the unified name. After this fix, it is not.

- At the gateway, before scope check, resolve the unified action
  to its granular tool, using the actionRisk table. Scope is checked
  against the granular risk, not the unified risk. A `read:tools`
  client can therefore call `tabs.list` through the unified tool,
  because the action is read-only, and cannot call `tabs.close`
  through the same tool without `call:tools`, because the action
  is reversible. Today it cannot call either, because `tabs` as a
  whole is reversible.
- At the bridge and host, approval is requested for the granular
  tool and canonical input, with the unified name kept only as a
  "called as" field for debugging. The approval fingerprint is
  granular, so a client cannot reuse an approval for `tabs.list`
  to close a tab.
- Rate limiting moves to granular tool per client, not unified
  tool per client. Heavy `tabs.list` calls no longer block
  `tabs.close`, and heavy `observe` calls do not block `act`.
- Audit, dashboard Activity, and task step keys all use the
  canonical granular name. A task step that used `navigate.close`
  and a step that used `tabs.close` are recognised as the same
  effect for idempotency and for reporting, not as two different
  tools.
- Errors return the canonical tool name and the action, so the
  client learns the precise name and can call it directly next
  time, instead of guessing another unified action.

This fix alone removes the main unified-tools risk, without
removing unified tools themselves.

### 2.3 Smart discovery v2 — replace keyword top 12

Current discovery: keyword scoring on name, title, and description,
top 12, limit 1 to 12, no category, no tags, no permission filter
beyond the live list, and no memory of what was already discovered.

New discovery, deterministic, no machine learning needed:

- Score by: exact name match first, then tag match, then category
  match, then verb match in the action name, then description match.
  A tool that matches a tag and a category outranks a tool that
  only matches a word in a long description.
- Filter first by permission level and OAuth scope, so a client
  never discovers a tool it cannot call, and never sees a tool
  that is denied by policy as if it were available.
- Return up to 20, grouped by category, with for each tool: name,
  title, one-line description, risk for the matched action,
  approval required yes or no, and related tools. Do not return
  full schemas for all 20 by default; return full schema only for
  the top 5, and schema pointers for the rest, to save context.
- Always include prerequisites and related tools for the top
  match. If the client discovers `form.submit`, it also gets
  `form.preview` and `form.fill` as related, with a note that
  preview is required before submit.
- Session-aware ListTools: the gateway remembers, per MCP session,
  which tools the client already discovered, and includes them in
  later ListTools responses, in addition to the core set. A client
  does not lose a discovered tool because it called ListTools again,
  and it does not need to re-discover it. This is a session cache,
  not a permanent permission change, and it is cleared when the
  session closes.
- Discovery for tasks: `tasks.*` are already in the core set, so a
  task client does not need to discover them. Task discovery is
  for the tools inside a task plan, not for task tools themselves.

### 2.4 Context budgeting and task-aware tool sets

MCP ListTools today is static per session, except for permission
level and show-all. Smart management makes it adaptive, within
safe limits:

- Core set stays small and stable: `observe`, `act`, `navigate`
  (URL and sync only, after deprecation, see section 5), `form`,
  `data`, `tools.batch`, `tools.discover`, plus `tasks.*` for task
  clients. That is the default for every client.
- Task mode: when a client creates a task, the gateway can offer
  a task-mode tool set for that session, meaning core plus the
  tools the task plan actually needs, discovered once at task
  creation, not all 135 tools. This is an offer through discovery,
  not a silent restriction: the client can still discover any
  other allowed tool.
- Client-aware limits: Claude and ChatGPT web have different tool
  limits and different context handling. The gateway should not
  pretend they are the same. Record the client type at initialize,
  if the client declares it, and cap the ListTools response size
  and the discovery return size for that client type, with the
  cap documented, not hidden. Do not invent a client limit that
  cannot be verified; use a conservative, documented cap and
  adjust it from live test results.
- Generated instructions: MCP instructions today are hand-written
  in cloudflare/src/mcp.ts and can drift from the registry. Generate
  the tool-selection part from the registry: the Observe -> Reason
  -> Act -> Verify loop, prefer `tools.batch` for independent reads,
  prefer unified for simple actions, prefer granular for precise
  actions, never use a deprecated tool, always preview before
  submit, always re-observe after navigation. Hand-written guidance
  stays for safety and for the product, generated guidance stays
  for tool names, actions, and risks, so they cannot drift.

### 2.5 Tool health, telemetry, and dashboard

Audit already records tool calls, but it is in-memory, bounded at
1,000 events, and the dashboard Tools page only shows allowed
versus denied, with a search by name, description, or category.

Add, without changing the execution path:

- Aggregates per canonical tool, from audit events, computed in
  the extension and exposed to the dashboard: calls, success rate,
  timeout rate, approval denied rate, average latency, average
  output size, and truncated rate. No page content, no inputs, no
  screenshots in aggregates.
- Dashboard Tools page: add health columns and filters, for
  example high timeout rate, high error rate, high approval denial,
  and a "needs attention" filter. A tool with a high timeout rate
  is a candidate for a longer timeout or a split step, not for
  silent removal.
- No auto-disable without user action. A tool that is failing
  gets a warning in the dashboard and in ListTools description,
  with the reason, but it is not removed by the system on its own.
  The user can toggle it off, as today, with an explicit override.
- Tool usage in tasks: task step keys and task summaries already
  use canonical names after section 2.2, so task health can be
  reported per tool as well, for example "act.click timed out in
  3 of 20 tasks".

## 3. What stays granular, what stays unified, what gets deprecated

### 3.1 Stay unified, as the default client-facing layer

- `observe`: read-only, clean, no mixed risk. Keep as the main
  read tool.
- `act`: reversible, with consequential sub-actions forced to
  consequential in host protocol for act and submit. Keep, with
  per-action risk table making the submit path explicit.
- `form`: reversible, with submit and set_file requiring approval
  through granular gates. Keep, with preview required before submit
  stated in metadata, not just in description.
- `browser`: read-only, clean. Keep.
- `wait`: read-only. Keep.
- `windows`: reversible, clean, only list, create, update, close.
  Keep.
- `clipboard`: sensitive-read for read, consequential for write,
  approval true for both in granular. Keep as its own unified tool,
  do not fold it into `data`, because clipboard is sensitive and
  must be visible as its own permission.

### 3.2 Stay granular, do not unify

- `tasks.*`: 6 tools, already in core, different risks and scopes
  for get/list versus create/pause/resume/cancel, different strict
  schemas, lifecycle verbs that must never be confused by an
  action string. Keep granular. Future `tasks.approvePlan` and
  dry-run also stay granular, for the same reason.
- `tools.batch` and `tools.discover`: meta tools, not domain tools.
  Keep granular and in core.
- Restricted tools: none in use today, but any future restricted
  tool must stay granular and denied, never hidden inside a unified
  tool.

### 3.3 Deprecate, then remove in a major version

- `navigate` tab and window actions: duplicate `tabs` and `windows`.
  Deprecate in registry 2.2, with description "deprecated, use
  tabs.* / windows.*", alias in the existing alias table, and a
  warning in audit. Remove in registry 3.0. Keep `navigate` for
  URL open, back, forward, reload, search, and sync wait only.
- `data` domains `devtools` and `clipboard`: duplicate the separate
  `devtools` and `clipboard` unified tools, and the granular tools
  underneath. Deprecate in 2.2, keep `data` for bookmarks, history,
  downloads, and files only, with the same alias and warning
  approach. Remove the deprecated domains in 3.0.
- `files` as a separate unified tool that only lists and stats:
  keep it for now, because it is read-only and clean, but do not
  expand it. If file write tools are added later, they go through
  granular `forms` and `data` file actions, not through a new
  unified file writer, unless a per-action risk table is added
  first.

Deprecation rules, to avoid breaking existing clients silently:

- A deprecated tool or action still works in 2.x, with a warning
  in its description and in audit, and with a "use instead" name.
- A deprecated tool is never in the core set, and never returned
  first by discovery. It is returned only on exact name match.
- Removal happens only in a major registry version, with a
  changelog entry, a migration note, and a dashboard notice.
  No silent removal in a minor version.

## 4. Build order

### Phase 1 — Safety: per-action risk, canonicalisation, governance (must, first)

- Add actionRisk tables for all 13 unified tools, with granular
  target, risk, approval predicate, and side effect per action.
  Audit every unified handler for a missing approval check; any
  missing check is a bug, not a feature.
- Build the Tool Manager resolution layer at gateway and bridge:
  resolve alias and unified action to granular, check scope and
  policy per granular, request approval per granular, rate limit
  per granular, audit canonical name.
- Add registry tests: every unified action has a granular target,
  a risk, and an approval rule; every granular tool has tags;
  no duplicate canonical targets; no unified tool hides a
  restricted action; no output schema is `z.any()`; every file
  cap and coordinate cap is stated in the schema, not just in
  the handler.
- Add a new-tool checklist to the docs and to CI: strict schema,
  caps, risk per action, approval predicate, tags, prerequisites,
  related tools, when-not-to-use, tests for success, failure,
  and approval denial, and a dashboard entry.
- Registry bump to 2.2.0, additive only, old clients ignore new
  metadata fields. No tool removed in this phase.
- Exit test: a `read:tools` client can call `tabs.list` through
  unified, cannot call `tabs.close` through unified, and audit
  shows `tabs.list` and `tabs.close` as canonical, not `tabs`.
  A `data.delete` call requires approval and is audited as
  `bookmarks.delete` or `history.delete`, not as `data`.

### Phase 2 — Smart discovery, context, and generated guidance (next)

- Discovery v2: tag and category scoring, permission and scope
  filtering, grouped return up to 20, full schema for top 5 only,
  prerequisites and related tools included.
- Session-aware ListTools: discovered tools stay in the session's
  ListTools response until the session closes.
- Task-mode tool sets: at task creation, discover once the tools
  the plan needs, offer them as the session's task set, with
  normal discovery still available for anything else.
- Generated MCP instructions for tool selection, from the registry,
  with hand-written safety guidance kept separate.
- Dashboard Tools page: add per-action risk view for unified tools,
  so a user can see that `tabs.list` is read-only and
  `tabs.organise` is consequential, even though both are under
  `tabs`.
- Exit test: a client discovering "organise tabs" gets `tabs`
  organise, `workflows.organizeTabs`, and `tabs.group` as related,
  with risks and approval flags correct, and does not get a
  clipboard or download tool in the top results. A client that
  discovered a tool in step 1 still sees it in ListTools in step 10.

### Phase 3 — Cleanup, health, and deprecation (after Phase 2)

- Deprecate `navigate` tab and window actions and `data` devtools
  and clipboard domains, with warnings, aliases, and dashboard
  notices, as in section 3.3. No removal yet.
- Dashboard health: per-canonical-tool aggregates, filters for
  high timeout, high error, and high approval denial, with no
  auto-disable.
- Tool inventory report, generated from the registry, listing
  every tool, its canonical target, risk per action, approval,
  tags, and deprecation status, so the inventory can never drift
  from the code again. This report replaces hand-counted tool
  numbers in docs and onboarding copy.
- Exit test: inventory report matches the registry exactly, with
  no tool counted twice and no deprecated tool in the core set.

### Phase 4 — Adaptive, only after Phases 1 to 3 prove out (later)

- Client-aware ListTools caps, based on measured client limits
  from live tests, not guessed limits, with caps documented.
- Telemetry-driven guidance: if a tool has a high timeout rate
  for a client type, suggest a split step or a granular alternative
  in discovery, with the reason stated.
- Tool recommendations by task type, for example research tasks
  suggest observe, data, and batch; form tasks suggest form
  preview, fill, and submit; organise tasks suggest tabs group
  and organise. Recommendations are suggestions in discovery,
  never restrictions, and never replace user policy or approval.
- Removal of deprecated tools in registry 3.0, only after a
  migration note and a dashboard notice, and only if live usage
  data shows the deprecated actions are no longer in common use.

### What not to build

- Do not build a machine-learning tool recommender that guesses
  tools from free text. Deterministic tag, category, and action
  scoring is auditable, testable, and sufficient for 135 tools.
- Do not build a second executor for unified tools. Unified always
  dispatches to granular.
- Do not auto-disable a failing tool, auto-approve a tool because
  it was used often, or auto-expand a tool's scope because a task
  needs it. Frequency is not approval.
- Do not move tool management to the gateway alone. The gateway
  can filter and discover, but the extension is the authority on
  what may run now, and on policy and approval for the granular
  action.
- Do not unify tasks tools, for the reasons in the previous turn.
  Group them in docs and dashboard, not in MCP schema.

## 5. Versioning

- Registry 2.2.0: per-action risk tables, canonicalisation,
  discovery v2, and deprecation warnings, all additive. Old
  clients ignore new metadata, and deprecated tools still work.
- Registry 3.0.0: removal of deprecated `navigate` tab and window
  actions and `data` devtools and clipboard domains only, with a
  migration note. No other breaking change in that release unless
  it is separately approved.
- Tool count in docs and onboarding must be generated from the
  registry, never hand-written, so a count like the old stale
  "112 tools" cannot drift again.

## 6. How we prove it works

- Safety test, Phase 1: per-action scope, approval, rate limit,
  and audit, for every unified action, with a test per action,
  not just per tool. A missing approval check fails the suite.
- Discovery test, Phase 2: a set of 20 intent queries, for
  example "organise tabs", "read clipboard", "fill a form",
  "collect links", "take a screenshot", each must return the
  correct tool in the top 5, with correct risk and approval,
  and must not return a tool from an unrelated category in the
  top 5.
- Context test, Phase 2: ListTools response size for the core set
  must stay under a documented budget, and a session that
  discovered 10 tools must still see them in ListTools after
  10 more calls, without re-discovering.
- Cleanup test, Phase 3: inventory report matches registry, no
  deprecated tool in core, deprecated actions still work with a
  warning, and audit shows the canonical granular name.
- Live test, after Phase 1: the same safety tests run in Claude
  and in ChatGPT web, with a `read:tools` client and a `call:tools`
  client, to prove scope per action works end to end, not just
  in mock tests.
