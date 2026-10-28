# Muze AI — OpenCode Architecture Adoption Plan

**Status: PLAN ONLY.** No Muze source code was changed for this plan. No push, no
deploy, no live Muze/MCP/browser calls, no live post. The original
`~/workspace/user/files/ext.zip` is untouched.

**Version note:** Muze is at 0.5.0 in this tree. One research track reported a
site-specific prompt still in `cloudflare/src/mcp.ts`; a direct grep of the tree
contradicts that — `ListPrompts`/`GetPrompt` expose only the three generic
prompts (`autonomous_browser_agent`, `extract_structured_data`,
`fill_and_submit_form`), and the test asserts the site-specific prompt is
absent. This plan trusts the verified tree and contains **no site-specific
procedure in any example**.

## 1. Core principle

> **Behaviour is enforced by tool visibility, state, and loop structure —
> not by prompt text alone.**

OpenCode's `plan` agent does not avoid editing because a prompt tells it not
to: it is never shown an edit tool. Denied tools are removed from the tool list
before the model call (`visibleTools()` in the OpenCode permission walkthrough,
`packages/opencode/src/session/prompt.ts` tool resolution). Muze today does the
opposite in its most important place: `MCP_INSTRUCTIONS` *tells* an outside
client to observe, verify, and not stop mid-task, while Muze itself executes
whatever single tool call arrives next. Adopting OpenCode means moving each
guarantee from "text the client may ignore" into one of three places that Muze
actually controls:

1. **Tool visibility** — what ListTools shows, and what scope/policy allow.
2. **State** — what the task runner checkpoints, and what the gateway mirrors.
3. **Loop structure** — what the task runner does per iteration: resolve tools,
   execute, observe, verify, checkpoint, stop on a defined condition.

Everything in this plan is judged against that test. If a change only adds
prompt text, it does not count as adoption.

## 2. How Muze works today (verified from code)

### 2.1 Gateway — `cloudflare/src/mcp.ts`, `bridge.ts`, `session-do.ts`, `directory-do.ts`, `oauth.ts`

- **One static instruction string, not per-call assembly.** `MCP_INSTRUCTIONS`
  (`mcp.ts:69`) carries the Observe → Reason → Act → Verify loop, execution
  discipline, a how-not-what task-brief section, and approvals. Server
  construction (`mcp.ts:835,852`) sends
  `instructions = MCP_INSTRUCTIONS + GENERATED_TOOL_SELECTION`. That is the
  whole assembly: two fixed strings. No tab state, policy state, task state,
  or history is injected per call.
- **ListTools is already filtered, and fail-closed.** If a browser is
  connected, the extension's live list is authoritative (already filtered by
  dashboard permission level); on live-fetch failure a ≤5 s cache is used,
  otherwise nothing is returned. If no browser is connected, the static
  registry is used. `filterToCoreTools()` reduces to the core set unless
  `MCP_SHOW_ALL_TOOLS` is set. The cap is 50 for every client type
  (`extension/libs/tool-contracts/tool-meta.ts:305–324`).
- **Session-aware discovery is in-memory only.** `discoveredTools` plus
  `rememberDiscovered()` (`mcp.ts:877`) append discovered tools to later
  ListTools, only if still in the current list and passing scope. It is cleared
  on session close and never changes permissions.
- **Scope is per granular action, before the bridge.** `assertScopeAllows`
  runs in `CallTool` before forwarding. `read-only` needs `read:tools` or
  `call:tools`; `reversible`/`sensitive-read`/`consequential` need
  `call:tools`; `restricted` is denied for every scope. Unified tools are
  resolved to their granular tool first (`resolveUnifiedToolForScope`), so one
  unified name can be partly allowed and partly denied. Only two scopes
  exist: `read:tools`, `call:tools` (`cloudflare/src/oauth.ts`).
- **Confirmation flags are stripped, never approval.** `stripConfirmationFlags()`
  (`mcp.ts:339`) removes `confirmed`/`userApproved`/`approved` in `CallTool`,
  per batch item, and again in `runWithApproval`.
- **One account = one browser session (confirmed).** `DirectoryDO.ensureAccount`
  maps `acct:<userId>` to exactly one `{sessionId, deviceToken}` row; a second
  sign-in reuses it. A second extension therefore gets the same session/token
  and its bridge connection closes the first with `1000 "replaced by new
  connection"`. There is no browser picker and no multi-browser fan-out.
  Multiple *clients* are different: up to 32 MCP sessions (`MAX_MCP_SESSIONS`)
  may share one browser session in `SessionDO`, with oldest-eviction that
  skips clients owning a running task when possible.
- **Bridge auth is a first-message frame, never a URL token.** The extension
  dials `/bridge?session=<sessionId>` (routing only; missing session → 400),
  then must send `{"type":"auth","token":"<device token>"}` within 5 s, verified
  via `DirectoryDO.authDevice`, else close 4401/4403. Nothing is forwarded
  before verification. `DoBridge` (`bridge.ts`) correlates requests
  (`gw_<n>`), with 60 s tool timeout and 120 s approval timeout.
- **Rate limits are HTTP-level, not agent budgets.** `/mcp` 300/min,
  `/bridge` 60/min, others 20–120/min (`cloudflare/src/index.ts`, `rate-limit-do.ts`).
  Extension-side per-tool limiting is a separate token bucket (capacity 120,
  refill 20/s, keyed `<clientId>:<canonical-tool>`).

### 2.2 Extension execution — `extension/libs/browser-engine/`, `extension/src/`

- **No agent loop of its own.** The reasoning loop lives in the external MCP
  client. The extension is a tool-execution engine plus a durable step runner.
- **Snapshot is DOM-derived, never Chrome's real AX tree.** `page/agent.ts`
  (1,540 lines, injected into the page) builds `snapshot`/`a11yTree` from the
  DOM: `implicitRole()` (explicit role, else tag/type mapping),
  `accName()` (aria-label → aria-labelledby → label → alt/title → text,
  truncated to 300 chars), plus value/checked/disabled/focused/box. When
  `interactiveOnly` is true, only a fixed role set is emitted
  (`button|link|textbox|checkbox|radio|combobox|listbox|option|menuitem|tab|
  switch|slider|searchbox`); `page.snapshot` hard-forces it. A separate
  `domStructure` op returns a flat `{depth, tag, id, classes[]}` list, rebuilt
  into a tree by `buildAstTree()` in `tools/unified.ts`. Open shadow roots are
  traversed. Sensitive field values are suppressed; `value`/`srcdoc`/`nonce`/
  `defaultvalue` attributes are never collected.
- **Refs are per-frame, in-page, ephemeral.** `refFor()` mints
  `r` + base-36 sequence + 4 random chars, stored as `__muzeRefElements`
  (Map ref → WeakRef) + `__muzeElementRefs` (WeakMap) + a `data-muze-ref`
  attribute. **Stale rule, fail-closed:** `resolve()` returns the element only
  if the WeakRef is alive and still in the document; otherwise callers surface
  `STALE_ELEMENT`. `findElements` deliberately does not store the query, so a
  later resolve can never re-run it onto a different element. Frame targeting
  is explicit: a call with no frameId means main frame 0, sent as
  `{frameId: 0}` (`chrome-context.ts`, `runPersistentPageAgent`); contradictions
  are `INVALID_INPUT`, never a silent choice.
- **Unified tools are a facade, resolved twice.** 13 unified tools
  (`browser, tabs, windows, navigate, observe, act, wait, form, submit,
  devtools, data, clipboard, files`) fan out via `exec.invoke("<granular>")`
  in `tools/unified.ts` (e.g. `observe` fans out per `include`; `act` runs up
  to 20 steps, `stopOnError` default true, target resolution
  ref → role+name → label → selector → coordinates). Separately, a unified call
  is canonicalised to one granular tool + canonical input for approval,
  audit, rate-limit, and scope (`resolveUnifiedToolForScope` at the gateway,
  `resolveUnifiedToolCall` in `extension/src/host-protocol.ts`). An approval
  for one granular action can never be consumed by another.
- **Executor pipeline, single order** (`executor.ts`): Zod validation →
  policy target derivation (tab's current URL) → policy `decide()` →
  dry-run short-circuit → approval consume (broker token, `planApproved`
  internal-only, or nested-call inheritance; client flags ignored) → per-client
  per-tool rate limit → execution with timeout + AbortSignal → output-schema
  validation + size bounding (over-limit output returned labelled `truncated`
  with a preview, never silently replaced). Audit records size/truncation
  metadata only, never content.
- **CDP is a fast path, not the snapshot.** 19 tools use CDP via 7 CDP methods
  (`interact.ts`, `cdp-controller.ts`); sub-frames and cross-origin frames fall
  back to synthetic page-agent dispatch. `dom.focus` stays on the browser focus
  API (no CDP focus command).

### 2.3 Tasks — `extension/libs/tasks/{runner,store,types}.ts`

The task runner (~2,006 lines) is the closest thing to a loop in Muze, and it
is **not** an LLM loop: the client supplies a complete ordered `steps[]`
(`{tool, input}`) at `tasks.create`; there is no tool to add, remove, reorder,
edit, or re-run a single step, and no tool to create a task from a goal.

- **State:** `chrome.storage.local` key `muze.tasks`
  (`{version: 1, tasks: TaskRecord[]}`), max 50 tasks, max 100 steps/task,
  completed tasks pruned after 7 days unless pinned. Per-step timeout 30 s
  default / 60 s max; total budget 600 s default; max 2 attempts/step.
  Statuses: `created, running, paused, waiting_approval, done, failed,
  cancelled, partial` (`partial` = honest ending, never reported as `done`).
- **Checkpoint rule, strict order:** record step result → persist whole store
  → write audit entry (task id, step index, tool, decision, outcome — never
  inputs/secrets) → emit progress view → only then start the next step. The
  loop reloads from storage before every step, so a pause/cancel issued
  mid-step wins.
- **Idempotency:** deterministic key = SHA-256 of
  `taskId + stepIndex + stableStringify(canonicalInput)` (FNV-1a fallback).
  A consequential step already `done` is never re-executed; on resume it
  returns the stored output.
- **Parallelism, bounded:** consecutive `independent: true` steps in a
  `parallelGroup` run together, capped at 4; consequential steps join a batch
  only under an active in-bounds plan approval. Per-tab serialisation via
  per-tab promise chains for consequential steps carrying a `tabId`.
- **Grounding before consequential steps:** `preStepObserve` (real `observe`,
  `include: ["metadata","a11y"]`, maxNodes 200) checks the step's ref still
  appears; stale → step stays `pending`, task pauses (`stale-ref`). Unknown-
  effect steps (bridge disconnect, unclassifiable errors) become `unknown`
  and pause; `resolveUnknown` re-observes first (URL match, or read-only =
  safe to re-execute; unconfirmable consequential effect throws and requires
  manual check) and only then re-executes once.
- **Tab gates:** tab must still exist; if its URL differs from the URL pinned
  at creation and the step is not a navigate tool → `tab-navigated-externally`
  pause. Policy version/mode is snapshotted at creation and re-checked at run
  start and before every step; a change pauses (`policy-changed`).
- **Plan approval / dry-run / bounds:** `tasks.approvePlan` is a separate tool,
  never a client flag. Sources: single-use broker token (verified then burned),
  dashboard, or elicitation. Bounds (`allowedTools`, `allowedRiskLevels`,
  `allowedDomains`, `allowPurchases`/`allowPayments`/`allowExternalSubmit`
  defaulting to deny, `maxSteps`, `maxAttemptsPerStep`, `totalBudgetMs`)
  default domains from the plan itself, so a step touching a new domain pauses.
  Approval expires at min(now + 24 h, budget end). Approving does **not**
  start the task — `tasks.resume` is still required.
- **Compensation is the only "undo":** per-step kinds only
  `none | close-tab | navigate-back | delete-download | manual`, applied in
  reverse order on cancel, best-effort. External submits are never
  compensated. There is no page-state snapshot, DOM revert, or transaction
  rollback.
- **Working-tab group:** tabs a task touches move into a "Muze AI" tab group
  while it runs and are ungrouped (left open, never closed) when it ends.
- **Privacy invariant:** `TaskView` never carries raw step input — only tool
  name + argument keys and ≤500-char output summaries. The gateway task
  mirror is status-only (`{taskId, status, stepIndex, totalSteps,
  browserSessionId, updatedAt}`, max 100 entries, `mcp:tasks`): "the gateway
  must not retain what a task is doing, only how far it has got."

### 2.4 Approvals, policy, audit — `extension/libs/security/`

- **Three approval paths only, all fail-closed:** (1) broker token, single-use,
  bound by a 128-bit fingerprint to exact tool + canonical input + client ID,
  TTL 120 s (`approvals.ts`); (2) dashboard decision (`muze/approval/respond`,
  toolbar badge for pending); (3) verified elicitation — the gateway, on
  `APPROVAL_REQUIRED`, asks in chat, and on accept **mints a real broker
  approval on the extension** and records `respondApproval(true)` before
  retrying with that `approvalId`. Elicitation accept alone, without the
  minted approval, never executes. If no elicitation, the gateway creates an
  approval and waits up to 120 s for a dashboard decision; denial →
  `APPROVAL_DENIED`; undecided → `respondApproval(false)` and
  `APPROVAL_REQUIRED`, never an instruction to re-call with a flag.
- **Policy modes** (`policy.ts`): `restricted` (read-only only),
  `default` (approval required for sensitive-read and consequential),
  `unrestricted` (everything allowed, no confirmation — which is why a
  no-prompt run is consistent with an Unrestricted dashboard, not evidence of
  a bypass). `PolicyEngine.decide()` precedence: kill switch → restricted
  page (`chrome://` etc.) → blocked domain → per-client policy → manual
  per-tool denial → read-only gate → risk gate → allowed. A manual per-tool
  allow bypasses the read-only and risk gates but never the kill switch or a
  client policy.
- **Audit is in-memory only**, capped at 1000 events in the service worker,
  every record through `redact()`, never tokens, secrets, cookies, or tool
  inputs/outputs. It does not survive a service-worker restart.
- **Dashboard** (`extension/dashboard/`, Preact SPA) is a progress/permission
  console, not an agent console: Overview, Permissions, Tools (registry with
  risk + health aggregates from audit only, no auto-disable), Activity
  (audit + pending approvals grouped by client), Tasks (status, per-step tool
  + state + output summary, pause/resume/cancel/approvePlan; never step
  inputs, page content, or screenshots), Files, Onboarding. Tasks cannot be
  created or edited from the dashboard.

### 2.5 What Muze does NOT have (verified absences)

- **No compaction.** No conversation summarisation, context-window management,
  transcript truncation/replacement, or summariser model call anywhere in
  `cloudflare/src`, `extension/src`, or `extension/libs`. The only
  "summarize" tool (`workflows.summarizePage`) states in its own description
  that summarisation is performed by the connected AI client and the workflow
  never calls a model itself.
- **No per-call environment assembly.** Nothing builds a prompt from current
  tabs, policy, tasks, audit, or prior turns before a tool call. The only
  per-call context the gateway adds is verified client identity + OAuth scope.
- **No step cap / iteration budget for direct (non-task) work.** Per-tool
  timeouts, `act` ≤ 20 steps, `tools.batch` 1–8 calls, and task caps (100
  steps, 600 s) exist; there is no max-turns, max-observations, or wall-clock
  budget on a direct Observe → Act → Verify session, and no "give up and
  report" logic in the extension.
- **No subagents / delegation.** No spawning, child-task, or handoff mechanism
  in the registry, runner, or gateway.
- **No skill loading.** No skill files, skill registry, or runtime skill
  loading. Nearest equivalents are static data: `tool-meta.ts` tags/related/
  prerequisites, `discovery.ts` scoring, and fixed prompt templates — all
  build-time, none fetched or composed per task.
- **No snapshot revert / state rollback.** No DOM, tab, or browser-state
  checkpoint is ever captured for restoration.
- **No dynamic replanning.** A task plan is immutable after creation: no step
  insertion, deletion, reordering, editing, branching, conditionals, loops,
  or output-to-input dataflow (each step executes its stored input verbatim;
  outputs are only summarised, never substituted into later steps).
- **No cross-task memory or learning.** Persisted state is task records
  (≤50, 7-day prune), audit events, and policy/approvals. The only cross-call
  adaptation is discovery's health-based suggestion text (≥20% timeout/error
  rate) and session-scoped discovered-tool persistence in the gateway.
- **No built-in verification loop for direct calls.** Verification is
  instructed to the client and implemented only inside the task runner
  (pre-step observe, `resolveUnknown` re-observe, tab gates). A direct `act`
  call returns after dispatch with no follow-up observation, and `submit`
  explicitly reports `verified: false`.
- **No autonomous error recovery for direct calls.** `act` has `stopOnError`
  (default true) and per-step ok/error results, but no retry, fallback-ladder
  execution, or re-grounding inside the handler.

## 3. OpenCode architecture, beyond prompts (researched)

Sources are OpenCode docs (`opencode.ai/docs`, `opencode.ai/v2/docs`) and
code walkthroughs of `packages/opencode/src/`. Two lineages appear in sources
and must not be conflated: **V1** (`packages/opencode/src/`, the tree named in
the research brief) and **V2 docs** (renamed config: `permission` → ordered
`permissions` array, `bash` → `shell`, `task` → `subagent`). Where a claim is
version-dependent, it is flagged.

### 3.1 Tool system — `packages/opencode/src/tool/tool.ts`, `tool/registry.ts`, `session/prompt.ts`

- Every tool is `Tool.Info<Params, Metadata>`, created by
  `Tool.define(id, init)`. `init` is a plain
  `{description, parameters, execute}` object or an async function returning
  one; the runner calls `init()` to get the callable tool, and lazy `init()`
  keeps startup time independent of tool count.
- `Tool.define()` wraps `execute` with Zod validation before execution and
  `Truncate.output()` afterwards, unless the result sets
  `metadata.truncated` (self-truncating tools such as `read`).
- Result shape: `{title, output, metadata, attachments?}` — `title` is the
  short UI label, `output` is text returned to the model, `metadata` is
  structured UI/client data, `attachments?` are optional file parts.
- `execute(params, ctx)` receives `Tool.Context`: `sessionID, messageID,
  agent, abort: AbortSignal, callID?, messages` (full history), `extra?,
  metadata(input)` (streams partial title/metadata to the UI while running),
  and `ask(input)` (requests a permission mid-execution).
- `ToolRegistry` (initialised once per instance) holds built-ins, plugin
  tools, and file tools from `tool/`/`tools/` directories, and filters by
  model (e.g. GPT models get `apply_patch` and lose `edit`/`write`, others
  get the inverse).
- **Per loop iteration**, `SessionPrompt.loop` → `resolveTools()`
  (`prompt.ts:598–619` in V1) pulls registry tools, adapts them to AI-SDK
  tools, injects `Tool.Context`, and wires plugin hooks and `Permission.ask()`.
  Tool resolution is re-done every iteration, not cached once per session.

### 3.2 Permission system — `packages/opencode/src/session/prompt.ts:436–441`, `agent/agent.ts`, `opencode.ai/docs/permissions`

- **V1 (`PermissionNext`):** a ruleset is a flat list of
  `{permission, pattern, action}` triples. Evaluation returns `allow`
  (proceed silently), `ask` (block and prompt), or `deny` (throw a denied
  error with the causing config as context). Default when nothing matches is
  `ask` in the V1 evaluator quoted in the deep-dive (last wildcard match
  wins; a literal pattern with no wildcards behaves as exact; `*` = zero or
  more chars, `?` = exactly one; `~`/`$HOME` expanded). Convention: catch-all
  `"*"` first, specific rules after.
- **V2:** an ordered `permissions` array of `{action, resource, effect}`
  triples, same last-match-wins rule. V2 defaults are reported as permissive
  (allow everything except `*.env` reads → `ask`) — treat V2 defaults as
  unverified/version-sensitive.
- **Denied = hidden, not just refused.** At tool-resolution time, tools denied
  by the merged ruleset are *excluded* from the `ToolSet` sent to the model
  (`visibleTools()`). The same hiding applies elsewhere: denying a subagent
  removes it from the task-tool description entirely, and denying a skill
  hides it from the model and rejects loading.
- **Ask lifecycle:** `Permission.ask()` parks the call on a deferred in a
  pending map, publishes an event for the UI dialog, and awaits. `once`
  resolves only that call; `always` appends its patterns to an approved
  ruleset and auto-approves other pending requests that now evaluate to
  `allow`. Rejection fails all other pending requests in the session;
  rejection *with a message* raises a corrected error carrying the text as
  model-visible feedback (the dialog doubles as a steering channel).
- **Session vs agent merging:** each `Agent.Info` carries a ruleset; at
  execution time `PermissionNext.merge(agentPermission, session.permission)`
  produces the effective ruleset. Session permissions "can tighten or loosen
  agent-level defaults" (DeepWiki); the exact precedence inside `merge()` on
  direct conflict was **not verified** from a primary source — do not assume
  session always wins. Session permissions are stored on the session and can
  be set from per-call input via `Session.setPermission()`.

### 3.3 Session loop — `packages/opencode/src/session/prompt.ts:274–700`

- `SessionPrompt.loop()` is a `while(true)` loop. Each pass reloads the
  conversation from SQLite, rebuilds pending work from message parts (not
  in-memory state), and in order: (1) pops a queued `SubtaskPart` → dispatch
  child session, `continue`; (2) pops a `CompactionPart` → run compaction,
  `continue`; (3) checks `SessionCompaction.isOverflow()` → queue compaction,
  `continue`; (4) otherwise resolves agent, model, and tools, writes an empty
  assistant message to SQLite *before* streaming (so a crash leaves an
  interruptible row), streams via the AI SDK, executes tool calls as they
  arrive, and persists parts as they stream.
- **Exit condition:** `lastAssistant.finish ∉ ["tool-calls", "unknown"] AND
  lastUser.id < lastAssistant.id` (`prompt.ts:318–325`). A defensive check
  keeps looping when a provider reports `stop` but the message still contains
  tool calls.
- **Step cap:** `Config.Agent.steps` caps iterations. When `step >= maxSteps`,
  the `MAX_STEPS` string from `prompt/max-steps.txt` is injected as a
  synthetic assistant turn instructing the model to return a plain-text final
  answer instead of more tool calls (`prompt.ts:556–559`).
- **Abort/cancel:** each running loop holds an `AbortController`;
  `SessionPrompt.cancel(sessionID)` signals it, propagating into tool
  executions and the streaming call, then sets status `idle` and deletes the
  state entry. Calling `loop()` for an already-running session registers a
  callback instead of starting a second loop.
- Title generation runs on step 1 (`ensureTitle()` → title agent if the title
  is still the default pattern).

### 3.4 Compaction and pruning — `packages/opencode/src/session/compaction.ts`

- **Overflow trigger:** after each completed assistant turn,
  `SessionCompaction.isOverflow()` compares token count (input + cache-read +
  output; cache-write excluded) against
  `model.limit.context − min(COMPACTION_BUFFER, maxOutputTokens)`, where
  `COMPACTION_BUFFER = 20_000`. Auto-compaction is disabled by
  `config.compaction.auto = false`; manual compaction is via TUI keybind /
  REST API. (A secondary source cites a 32,000 buffer instead — unverified;
  do not adopt the number without checking the current file.)
- **Compaction flow:** the loop inserts a `CompactionPart`; next pass
  `SessionCompaction.process()` runs the hidden `compaction` agent over a
  flattened plain-text transcript, with each tool result clamped to
  `TOOL_OUTPUT_MAX_CHARS = 2_000` *for the summarizer only*. The reply is
  stored as an ordinary assistant message flagged `summary: true`; covered
  messages stop being sent (filtered by `MessageV2.filterCompacted`), but the
  old rows remain in SQLite. The summary prompt asks for what was
  accomplished, work in progress, files involved, next steps, and key
  requests/constraints/decisions. The preserved tail is
  `min(8_000, max(2_000, floor(usable × 0.25)))` tokens, with
  `DEFAULT_TAIL_TURNS = 2` also named.
- **Pruning (separate, lighter, opt-in):** `SessionCompaction.prune()` erases
  only the `output` field of old completed `ToolPart`s — call record and
  arguments stay. It protects the newest `PRUNE_PROTECT = 40_000` tokens of
  tool output and only acts if it can reclaim more than
  `PRUNE_MINIMUM = 20_000` tokens, because rewriting stored messages
  invalidates provider prompt cache. `compaction.prune` defaults to `false`.
  `PRUNE_PROTECTED_TOOLS = ["skill"]` — the sole exemption, because a skill
  injects instructions the model must keep following; clearing it would leave
  the model acting on a procedure no longer in context, with no error to trace.
- **V2 (reported, not verified against the official V2 config page):**
  hard-coded constants became config — `compaction.keep.tokens` (default
  15,000), `compaction.buffer` (15% of limit, at least 16k),
  `compaction.type: "summary" | "native"`, background compaction from 85% of
  threshold. Do not adopt these numbers without checking.

### 3.5 Subagents — `packages/opencode/src/tool/task.ts`, `agent/agent.ts`, `session/index.ts`

- Delegation is the `task` tool. The parent loop detects a queued
  `SubtaskPart`, creates a child assistant message with an in-progress `task`
  `ToolPart`, then `TaskTool.execute()` creates a child session via
  `Session.createNext({parentID})` and runs `SessionPrompt.prompt()` inside
  it; on completion the parent's `ToolPart` becomes `completed` with `output`,
  `title`, and optional `attachments`, and the parent loop continues.
  Passing an existing `task_id` reuses that session; otherwise a new session
  is created with no memory of a previous one.
- **Isolation:** the child session's context contains only the invocation
  prompt, the subagent's system prompt, and its own tool results — it cannot
  see parent history unless explicitly included in the prompt. Child sessions
  get `parentID` set.
- **Built-in subagents:** `general` (multi-step work; hard-coded denies:
  `todowrite`, `todoread`, `task` — so no recursive delegation) and `explore`
  (read-only tool set; exact set varies by version — one listing is
  `grep, glob, list, read, bash, webfetch`, another adds `websearch,
  codesearch`). Custom agents are Markdown files (frontmatter → config, body
  → system prompt) in `.opencode/agents/` or global config, with
  `mode: primary | subagent | all`.
- **Internal agents:** `title`, `summary`, and `compaction` run through the
  same loop, provider layer, and message store as a normal session. In the
  old Go code they were created with a literal empty tool list; in V1
  TypeScript they are achieved via a `{"*":"deny"}` ruleset plus
  `visibleTools()`, yielding an empty effective tool list. They use the small
  model (title/summary) or the main model (compaction).

### 3.6 Skills progressive disclosure — `opencode.ai/docs/skills`, `opencode.ai/v2/docs/skills`

- A skill is a directory containing `SKILL.md` (frontmatter `name` +
  `description`, then Markdown instructions, plus optional scripts,
  references, templates). Discovery locations (V1): `.opencode/skills/`,
  `~/.config/opencode/skills/`, `.claude/skills/`, `~/.claude/skills/`,
  `.agents/skills/`, `~/.agents/skills/`; project paths are walked up from the
  working directory to the git worktree. V2 adds explicit `skills` config
  entries and path-derived, case-sensitive IDs (frontmatter `name` is only a
  display label in V2; V1 required `name` to match the folder).
- **Tier 1 (catalog):** at each model step, only *permitted* skills with a
  description are listed — ID, name, description, never the body. In V1 this
  list is embedded as an `<available_skills>` block inside the native `skill`
  tool's description. Skills with `autoinvoke: false` are omitted from the
  advertised list but remain loadable by explicit ID; skills without a
  description are not advertised at all.
- **Tier 2 (load):** the model calls the `skill` tool with the exact ID/name.
  The body *without frontmatter* is added to the conversation, plus the
  skill's base directory and a sample of up to ten supporting file paths.
- **Tier 3:** supporting file contents are never auto-loaded; the agent
  reads/executes them only when the skill directs it to.
- **Permissions as disclosure control:** skill permission rules are ordered,
  last-match-wins, wildcard over IDs. `allow` = advertise + load without
  approval; `ask` = advertise + ask before loading; `deny` = hide from the
  model *and* reject loading. Disabling the `skill` tool for an agent omits
  the catalog entirely.

### 3.7 Instructions — `opencode.ai/v2/docs/instructions`, `opencode.ai/docs/config`

- **Scope/discovery:** global `~/.config/opencode/AGENTS.md`, then every
  `AGENTS.md` from the workspace toward the home directory, stopping at the
  project root for workspaces outside home (then only the global file loads;
  `OPENCODE_DISABLE_PROJECT_CONFIG=1` skips project discovery without
  disabling the global file). The doc's printed combination order is: global,
  then `packages/web/AGENTS.md`, then `packages/AGENTS.md`, then root
  `AGENTS.md`.
- **Nested discovery:** instruction files *below* the workspace are discovered
  lazily as the agent explores — reading a file or listing a directory loads
  any `AGENTS.md` between that target and the workspace, nearest-first,
  deduplicated while the instruction entry remains in model-visible history
  (a later read does not re-inject it; if compaction or a revert removes that
  entry, a later read can load it again).
- **Ordering (initial instructions):** (1) agent/provider system prompt;
  (2) tool guidance, when enabled; (3) MCP server, reference, and skill
  guidance; (4) global and project `AGENTS.md`, then configured instructions;
  (5) built-in date/environment context; (6) session-specific instruction
  entries supplied through the API.
- **Combined, not override:** "OpenCode combines the files and does not
  resolve conflicts between them." Configured instructions (`instructions:
  [...]` — files, globs, `~/` paths, absolute paths, or HTTP(S) URLs fetched
  with a 5 s timeout) load after `AGENTS.md` in listed order, and entries
  from every config document are combined. Nested files discovered later are
  appended to session history in discovery order.
- **Updates:** edits to a global or upward-discovered `AGENTS.md` are detected
  before the next model request and delivered as an instruction update before
  pending input (removing all ambient files tells the session the old
  instructions no longer apply; a transient read failure preserves last-known
  instructions). Edits to a *nested* (below-workspace) file are *not* detected
  automatically after it loads — start a new session for updated text to
  apply immediately. V2 recognises `AGENTS.md` only (no `CLAUDE.md` fallback);
  V1 fell back to `CLAUDE.md`.

### 3.8 MCP integration — `opencode.ai/v2/docs/mcp-servers`

- Servers are configured under `mcp.servers` (V2; V1 placed names directly
  under `mcp`): local = stdio command array, remote = Streamable HTTP URL
  with OAuth by default (PKCE, client discovery/pre-registered client).
  Servers connect automatically when a session starts; `disabled: true`
  keeps one configured without connecting. Timeouts: startup 30 s, catalog
  30 s, execution 12 h by default.
- **Tools:** each server tool becomes a model tool named `<server>_<tool>`,
  with characters other than letters, numbers, `_`, `-` replaced by `_`.
  Under default Code Mode, tools are grouped as `tools.<server>.<tool>(…)`;
  with Code Mode off they stay on the provider's native tool list. At each
  loop iteration `resolveTools()` fetches connected MCP tools alongside
  registry and LSP tools.
- **Prompts → commands:** MCP prompts become slash commands named
  `<server>:<prompt>` (same normalisation); command text fills the prompt's
  arguments in order. MCP *instructions* returned at initialisation are added
  to the system prompt as `<mcp_instructions><server name="…">…</server>
  </mcp_instructions>`; they are omitted when the agent's permissions deny
  every tool of that server.
- **Resources:** agents read MCP resources through built-in
  `list_mcp_resources` / `read_mcp_resource` tools, permissioned by server
  name and by `<server>:<uri>`.
- **Permissions without disconnect:** permission actions matching the
  normalised `<server>_<tool>` name can hide or deny individual tools without
  disconnecting the server. Calls made for a session carry the session ID
  only as request metadata, explicitly not an authentication credential.
- **Context-cost warning (verbatim from official docs):** "MCP tools consume
  model context, so add only the servers you need." Every enabled server's
  tool descriptions are registered with the model at the start of every
  session and can take a meaningful portion of the context window.

### 3.9 Storage / events — `packages/opencode/src/session/index.ts`, `session.sql.ts`, `session/message-v2.ts`

- **SQLite store:** sessions, messages, and parts persist via `Database`
  (`storage/db.ts`), with tables `SessionTable`, `MessageTable`, `PartTable`
  (`session/session.sql.ts`) in the V1 session walkthrough. A secondary
  architecture summary instead lists five tables (Session, Message, Part,
  Todo, Permission) via Bun bindings + Drizzle, WAL mode, 64 MB cache, per-
  project database at `~/.local/share/opencode/project/<hash>/data.db` — the
  Todo/Permission tables are **not confirmed** by the primary walkthrough;
  treat the five-table claim as version-dependent.
- **Data model:** `Session.Info`: `id` (descending `session_…`), `slug`,
  `projectID`, `directory`, `parentID?`, `title`, `version`, `summary`
  (diff stats), `share?`, `revert?`, `permission?` (session ruleset),
  `time.created/updated/compacting?/archived?`. `MessageV2.User` vs
  `MessageV2.Assistant` (the latter carries `parentID`, `modelID`,
  `providerID`, `cost`, `tokens`, `finish`, `summary?`); each message breaks
  into `Part`s — Text, Reasoning, File, Tool (state
  `pending → running → completed | error`), StepStart/StepFinish, Snapshot,
  Patch, Agent, Retry, Compaction, Subtask. `updateMessage`/`updatePart`
  upsert + publish; `updatePartDelta` publishes streaming deltas *without*
  writing to the DB.
- **Event bus:** all mutations publish on `Bus` (`Bus.publish` /
  `Bus.subscribe`), propagating state from business logic through the worker
  thread to the TUI without polling. Named events include
  `session.created/updated/deleted/diff/error/compacted/status`,
  `message.updated/removed`, `message.part.updated/delta/removed`.
  `SessionStatus` (`idle | busy | retry{attempt, message, next}`) is itself
  broadcast as `session.status`.

## 4. Mapping table

Difficulty: **S** = small, mostly wiring existing pieces; **M** = new logic in
one layer; **L** = new cross-layer behaviour, needs careful migration.

| Muze workflow area | Muze today (file) | OpenCode counterpart (file/doc) | Gap | Difficulty |
|---|---|---|---|---|
| Instruction assembly | Two fixed strings concatenated at server construction: `MCP_INSTRUCTIONS + GENERATED_TOOL_SELECTION` (`cloudflare/src/mcp.ts:69,370,852`) | Layered assembly per call: agent/provider prompt → tool guidance → MCP/skill guidance → AGENTS.md → date/environment → session entries (`session/system.ts`; `opencode.ai/v2/docs/instructions` ordering) | No per-call layers, no environment, no per-domain instructions, no session entries | M |
| Tool definition | Registry schemas + handlers, startup check that schemas = handlers (`browser-engine/registry-factory.ts`); result is a JSON tool result | `Tool.Info` with lazy `init()`, `{title, output, metadata, attachments?}`, Zod validation + truncation in the wrapper (`tool/tool.ts`) | No lazy init, no title/metadata/attachment channel, no wrapper-level truncation (Muze bounds output size and labels it `truncated` instead) | M |
| Tool resolution | Resolved once per call in the executor; ListTools filtered once per session (live list or static registry) | Re-resolved every loop iteration from registry + MCP + LSP, filtered by merged permissions (`session/prompt.ts:598–619`) | Resolution is per call, not per loop iteration, because there is no Muze loop; task runner caches policy snapshot at creation and re-checks it, but does not re-resolve the tool set | M (inside task runner); L (for direct calls, needs a loop owner) |
| Permission enforcement | Two independent gates: gateway OAuth scope (per granular action, pre-bridge) + extension policy modes (`policy.ts`); denied tools are refused at execution, and hidden from the *live* ListTools by policy, but the static fallback list is not mode-filtered the same way | One merged ruleset (agent + session); denied tools are *excluded* from the ToolSet sent to the model (`visibleTools()`; `session/prompt.ts:436–441`) | No single merged ruleset; no agent-mode tool set; a client that ignores ListTools still gets a refusal, not an empty world — which is safe but not OpenCode-style | M |
| Agent modes | Dashboard policy modes only: `restricted` / `default` / `unrestricted` (`policy.ts`) — these gate execution, they are not agent identities with distinct prompts and tool sets | Agents `build` / `plan` / `general` / `explore` + custom agents, each with mode, ruleset, model, steps, prompt (`agent/agent.ts`) | No read/act/plan agent modes as first-class objects; no mode-specific prompt or tool visibility | M |
| Session loop | None. External client owns the loop; Muze executes one forwarded call at a time. Task runner executes a fixed client-supplied step list | `SessionPrompt.loop()`: reload from SQLite, handle queued subtask/compaction parts, resolve agent/model/tools, stream, execute, persist parts, exit on finish ≠ tool-calls (`session/prompt.ts:274–700,318–325`) | No loop owner inside Muze; no queued-work parts; no finish-reason exit | L |
| Step cap / finish | Task caps only: 100 steps, 600 s budget, 2 attempts/step. No cap on direct sessions | `Config.Agent.steps` + `MAX_STEPS` synthetic turn (`prompt.ts:556–559`) | No synthetic finish turn; a direct session can in principle run unbounded (bounded only by client context and per-tool timeouts) | S (tasks); M (direct, needs loop owner) |
| Abort / cancel | Task pause/resume/cancel; bridge cancel propagation (`bridge.ts`); executor AbortSignal per tool | Per-loop AbortController; `cancel(sessionID)` propagates into tool executions and the streaming call, sets status `idle` (`prompt.ts:238–268`) | No loop-level abort for direct sessions; task cancel exists but does not propagate into a client-owned loop | S–M |
| Compaction | None. Only storage bounds: task summaries ≤500 chars, audit ≤1000 events, 7-day task prune, gateway mirror status-only | Overflow-triggered summarisation by a hidden compaction agent, `summary: true` message, old rows kept but filtered (`session/compaction.ts:90–175`) | No transcript exists to compact; compaction must be built on top of a history store that does not exist yet | L |
| Pruning | Storage bounds only (above); no context pruning | `prune()` erases old completed ToolPart outputs only, protects newest 40,000 tokens, acts only if reclaim > 20,000 tokens, protects `skill` outputs (`session/compaction.ts:50–90`) | No ToolPart-output store to prune; task output summaries are the only analogue, and they are already truncated at write time | M (once a history store exists) |
| Subagents | None. Fixed task lists, `act` batches, `tools.batch` reads, canned workflows (`tools/workflows.ts`, concurrency 4) | `task` tool → child session with `parentID`, isolated context, `general`/`explore` built-ins, recursion blocked by `task: deny` (`tool/task.ts`, `agent/agent.ts`) | No child-task mechanism, no parent/child state, no isolation boundary | L |
| Internal agents | None. Dashboard Tasks page is a progress view, not an agent | `title` / `summary` / `compaction` agents through the same loop and store, with an empty effective tool list (`agent/agent.ts`; Go: literal empty list; V1 TS: `{"*":"deny"}` + `visibleTools()`) | No internal agent concept; summarisation is explicitly deferred to the client | M |
| Skills | None. Static `tool-meta.ts` tags/related/prerequisites and `discovery.ts` scoring | Catalog (name+description only) at each step → `skill` tool loads full body → supporting files read on demand; `deny` hides (`opencode.ai/docs/skills`) | No skill registry, no load-on-demand tool, no disclosure control | M |
| Persistent instructions | Dashboard policy + onboarding in `chrome.storage.local`; no per-domain instruction files | `AGENTS.md` global → project → nested, lazy nearest-first discovery, combined not override (`opencode.ai/v2/docs/instructions`) | No instruction files, no lazy discovery, no ordering rule | M |
| MCP integration | Muze *is* an MCP server for outside clients; it also consumes no MCP servers of its own in the read paths | MCP servers become `<server>_<tool>` model tools and `<server>:<prompt>` commands, resolved per iteration, with a context-cost warning (`opencode.ai/v2/docs/mcp-servers`) | Inverted direction: Muze cannot control how outside clients register its tools; the context-cost lesson applies to Muze's *own* ListTools surface, not to servers it consumes | S (surface discipline); L (if Muze were to consume MCP servers itself) |
| Storage / events | Gateway Durable Objects (DirectoryDO, SessionDO, RateLimitDO) + extension `chrome.storage.local` (`muze.tasks`, `muze.policy`, `muze.bridge`, `muze.sessions` for tab save/restore) + in-memory audit/approvals in the service worker | SQLite Session/Message/Part tables + `Bus` publish/subscribe, live TUI without polling (`session/index.ts`, `session.sql.ts`) | No unified message/part store; audit and approvals are ephemeral; dashboard polls instead of receiving events | M–L |
| Snapshot / revert | No snapshot. Task recovery = re-observe + fresh refs + `resolveUnknown` re-execute-once + 4 compensation kinds on cancel | Filesystem snapshot at turn start + git diff summary + revert to snapshot or reverse diff (`session/summary.ts`, `session/revert.ts`) | No browser-state checkpoint exists to revert to; a tab/page snapshot is the analogue, and it is not captured | L |
| Verification | Instructed to the client; implemented only in the task runner (pre-step observe, tab gates, `resolveUnknown`); direct `act` returns after dispatch, `submit` reports `verified: false` | Loop-native: every tool result is appended as a ToolPart and the next model step sees it; verification is the next observation, not a separate instruction | Direct calls have no follow-up observation inside Muze | M (runner); L (direct) |

## 5. What CANNOT be adopted literally — and the browser/MCP equivalent

This is the section that decides whether the plan is honest. **Muze cannot
adopt OpenCode's loop literally, because Muze does not own the loop.**

- OpenCode runs its own `SessionPrompt.loop()` and calls its own model. Muze
  is an MCP server used by outside clients (ChatGPT, Claude, and Panda via
  the Muze connector) that Muze does not control. Those clients own the
  model call, the turn loop, and the context window. Muze cannot inject a
  synthetic `MAX_STEPS` turn into their loop, cannot force them to compact,
  and cannot make them fetch a skill, a prompt, or a mode. Any plan that
  pretends otherwise will fail on first contact with a real client.
- **Where the loop must live instead:** in two places Muze does control.
  1. **The extension task runner** (`extension/libs/tasks/runner.ts`) is the
     only loop Muze owns. It must become the OpenCode-style loop for
     multi-step work: reload state, resolve tools per iteration, execute,
     observe, verify, checkpoint, and stop on a defined condition. Direct
     single calls stay single calls — they are not looped, and must not be
     dressed up as looped.
  2. **Gateway session state** (`SessionDO`) is the loop's memory across
     MCP sessions: mode, discovered tools, task mirror, and (in later
     phases) loop state summaries. It must never become a transcript store
     for page content or step inputs — the existing status-only mirror rule
     stays.
- **Clients that ignore the new structure still get safety, not the new
  behaviour.** Tool visibility is an optimisation and a context saving; the
  security boundary stays where it already is — gateway scope per granular
  action and extension policy/approval per call. A client that calls a hidden
  tool directly must still get a refusal. Visibility without the refusal
  would be a regression; refusal without visibility is today's behaviour.

| OpenCode concept | Browser / MCP equivalent in Muze | Where it lives |
|---|---|---|
| Git snapshot at turn start + diff summary | Task checkpoint: task record + step results + a page snapshot (tab URL, a11y tree summary, form state) captured before a consequential step, stored in `muze.tasks` | `extension/libs/tasks/runner.ts`, `store.ts` |
| Revert to snapshot / reverse diff | No literal revert. Nearest honest equivalents, in order: (a) task compensation kinds on cancel (`close-tab`, `navigate-back`, `delete-download`, `manual`); (b) `resolveUnknown` re-observe and re-execute-once; (c) fresh refs after re-observe. A "restore tab from snapshot" (re-open saved URLs, re-apply saved form state) is a new feature, not a revert, and must be named as such if built | `runner.ts` compensation + `resolveUnknown` |
| SQLite Session/Message/Part | `chrome.storage.local` `muze.tasks` (task records) + SessionDO storage (`mcp:sessions`, `mcp:tasks`) for session state + in-memory audit/approvals (ephemeral, acknowledged as a gap) | `extension/libs/tasks/store.ts`, `cloudflare/src/session-do.ts` |
| Event bus → live TUI | Dashboard currently polls while open (`dashboard/pages/Tasks.tsx`). The equivalent is a push channel: service-worker → dashboard messages on task step/audit/approval events, plus the existing bridge `approval.resolved` broadcast. Polling stays as fallback, not as the design | `extension/src/service-worker.ts`, `task-dashboard.ts`, `dashboard/pages/Tasks.tsx` |
| LSP (code intelligence for the model) | DOM/AX snapshot (`page/agent.ts`) + merged snapshot work already planned in the grounding plan (DOM tree + heuristic interactive layer + CDP AX when available, dialog-first observe, delta snapshots). The snapshot is Muze's "language server": it is what the model reasons over, so its completeness and staleness rules are architecture, not UI polish | `extension/libs/browser-engine/page/agent.ts`, `extension/src/content/page-agent.ts` |
| Project working directory / git status | Current browser context: active tab id + URL + domain, open dialog/form/menu state, viewport, policy mode, task state. This is the environment layer in §6 | Assembled in Phase A from live extension state, not from a fixed string |
| `AGENTS.md` project instructions | Per-domain instruction notes, stored in the extension and loaded when a tab's domain matches (see Phase C). Global notes first, then domain notes, combined not override — the same ordering rule as OpenCode, applied to domains instead of directories | New store in `extension/libs/`, surfaced via dashboard |
| Internal title/summary/compaction agents | Internal task kinds that run through the same runner with a deny-all effective tool set (see §7): a summary child task that condenses completed steps, and a compaction child task that prunes old step outputs. They do not call a model inside Muze — they prepare a summary record that the *client* can use, and the client remains the summariser (as `workflows.summarizePage` already states) | `extension/libs/tasks/runner.ts` + a new internal-task kind |

## 6. Phased plan

### Phase A — Layered instructions + mode-filtered tool visibility (prove the architecture)

**Goal:** prove that behaviour can move from prompt text into assembly and
visibility, using only the gateway and existing policy — no extension
rebuild, no new loop, no client cooperation beyond reading ListTools.

**Concrete changes:**

1. `cloudflare/src/mcp.ts` — replace the two-string instruction assembly
   with a layered assembler, in OpenCode's order, adapted to Muze:
   - Layer 1, base: identity as a browser operator + the loop + execution
     discipline + approvals (today's `MCP_INSTRUCTIONS`, trimmed to how, not
     what — no task procedures, no site procedures).
   - Layer 2, mode: the agent mode's prompt (see §7) and its tool set, for
     the mode recorded on this MCP session.
   - Layer 3, tool guidance: generated tool-selection text, but only for the
     mode's visible tools (today it is generated for the whole registry).
   - Layer 4, environment: a short, structured snapshot assembled per
     initialize/refresh — active tab id + URL + domain (if a browser is
     connected), policy mode, and task state counts (running/paused tasks) —
     never page content, step inputs, or screenshots.
   - Layer 5, session entries: discovered tools for this session (already
     tracked in memory; move the record into SessionDO so it survives a
     gateway isolate restart).
2. `cloudflare/src/mcp.ts` + `extension/src/host-protocol.ts` — mode-filtered
   ListTools: a mode's denied tools are *excluded* from ListTools, not just
   refused at execution. The static fallback list gets the same mode filter
   (today only the live list is policy-filtered). Scope and policy refusals
   stay as the security backstop for clients that call a hidden tool directly.
3. Mode selection mechanism (design decision, stated plainly): a client
   selects a mode by fetching the generic agent prompt with a `mode`
   argument, or by creating a task with a `mode` field; the gateway records
   the mode per MCP session in SessionDO. Changing mode mid-task requires a
   new session or an explicit mode-switch that re-issues a ListTools
   notification — a task's mode is pinned at creation and never changes
   mid-task (mirroring how a task's policy snapshot and `browserSessionId`
   are already pinned).
4. `cloudflare/libs/tool-contracts/instructions.ts` — generate the
   tool-selection section from the *visible* tool set, not the full registry,
   so a read-mode client never pays context for act tools it cannot see.

**Deliberately NOT changed:** no extension code, no task runner semantics,
no approval rules, no scope rules, no dashboard, no model calls, no
compaction, no subagents. The client loop is untouched.

**Verification:**

- Unit tests: ListTools in read mode contains no act/form/submit tools and
  no consequential granular actions; ListTools in plan mode contains no
  write tools at all; a direct call to a hidden tool still returns a scope/
  policy refusal (visibility is not security).
- Gateway typecheck + full Cloudflare suite green (the known flaky
  `gateway.e2e` socket-auth timing test must be reported honestly if it
  fails, not hidden).
- Live proof (no live post required): connect a client, fetch the agent
  prompt in read mode, and show ListTools with no acting tools; then in act
  mode, show the acting tools present. Record the initialize payload size
  before/after — the point of the phase is measurable context saving, so
  measure it.

### Phase B — The task runner becomes the loop

**Goal:** make the one loop Muze owns behave like OpenCode's loop: reload
state, resolve tools per iteration, execute, observe, verify, checkpoint,
stop on a defined condition.

**Concrete changes:**

1. `extension/libs/tasks/runner.ts` — per-iteration tool resolution: before
   each step, re-resolve the step's tool against the current policy snapshot,
   mode, and scope, instead of trusting the tool set cached at creation.
   A tool that has become denied pauses the task (`policy-changed` already
   exists; extend it to tool-set changes).
2. `runner.ts` — verification as a runner step, not a client instruction:
   after each consequential step, the runner automatically runs a verify
   observation (same `preStepObserve` machinery, post-step) and records the
   verify result on the step. A step whose verify observation does not show
   the expected state (as defined by the step's own verify condition, supplied
   by the client at creation — a generic condition such as "element present"
   or "URL matches", never a site procedure) becomes `unknown` and pauses,
   instead of being marked `done` on dispatch. This is the direct fix for
   "dispatched ≠ success" inside Muze's own loop.
3. `runner.ts` — step cap as a synthetic finish turn: when the step budget,
   total budget, or attempt budget is exhausted, the runner writes a final
   report (done/undone/failed indices + compensations + manual cleanup) and
   stops with status `partial` or `failed` — never a silent loop, never an
   unbounded retry. This mirrors OpenCode's `MAX_STEPS` synthetic turn, with
   the report as the "plain-text final answer" (the runner cannot generate
   text itself; it assembles the report from step records).
4. `runner.ts` — abort propagation: task cancel aborts the in-flight tool
   call's AbortSignal and any pending verify observation, then runs
   compensations. Today cancel is checked between steps; make it interrupt
   within a step where the tool supports it.
5. `runner.ts` + `store.ts` — page snapshot checkpoints: before each
   consequential step, capture a bounded page snapshot (tab URL, a11y tree
   summary, form state) into the step record. This is the browser equivalent
   of OpenCode's turn-start snapshot. It is used for verify comparison and
   for `resolveUnknown`, not for automatic revert (see §5).
6. `extension/src/host-protocol.ts` — keep the tasks-are-not-executor rule:
   `tasks.*` messages continue to bypass the executor directly and go to the
   runner, so loop changes cannot become an approval bypass.

**Deliberately NOT changed:** no step generation, no replanning, no step
insertion/deletion/reordering, no output-to-input dataflow, no model calls.
The plan stays client-supplied and immutable; Phase B makes its *execution*
loop-shaped, it does not make the runner a planner.

**Verification:**

- Extension typecheck + full extension suite green; new runner tests for:
  verify-fails → `unknown` + pause (not `done`); tool-becomes-denied
  mid-task → pause; budget exhausted → final report + terminal status;
  cancel during a step → abort signalled + compensations run.
- Live proof (no live post required): run a multi-step read-only task on a
  generic page, pause it mid-run, resume it, and show checkpoint recovery
  from storage (not from memory) plus a verify observation recorded on a
  consequential step. No consequential live action is required for this proof;
  if one is used, it must be on a disposable tab and reversible.

### Phase C — Compaction, pruning, subagents, skills, per-domain instructions

**Goal:** add the three OpenCode mechanisms that Muze lacks entirely, in
their browser-safe forms. This is the largest phase; it depends on Phase B's
loop and checkpoint machinery.

**Concrete changes:**

1. **Compaction + pruning** (`runner.ts`, `store.ts`, new
   `extension/libs/tasks/compaction.ts`):
   - Define a task history record: step results are kept in full only for a
     bounded tail (the most recent N steps, N configurable, default matching
     today's summary behaviour); older steps are replaced by a summary
     record (tool, outcome, output summary ≤500 chars — today's
     `TaskView` shape, reused, not invented).
   - Pruning, OpenCode-style: erase only the *output* field of old completed
     step records, keep the call record and arguments (needed for
     idempotency keys and resume). Protect the newest tail and protect
     instruction-bearing records (policy snapshot, plan approval, skill
     bodies — the analogue of OpenCode's `PRUNE_PROTECTED_TOOLS = ["skill"]`).
     Act only if the reclaim exceeds a minimum threshold, so storage rewrites
     do not thrash on tiny savings.
   - Compaction, Muze-style: a summary record is *prepared* by an internal
     task (see below) from completed step summaries; the client remains the
     summariser for prose, exactly as `workflows.summarizePage` already
     states. Muze never calls a model to summarise. The summary record
     replaces the covered steps in the *view* presented to the client; the
     raw records are retained in storage until the 7-day prune, so
     compaction is reversible by inspection, not destructive.
2. **Subagents as child tasks** (`runner.ts`, `types.ts`,
   `host-protocol.ts`):
   - A child task is a `TaskRecord` with `parentId` set, created by a parent
     task step of a new kind (`tasks.createChild`, internal to the runner,
     not a new MCP tool at first). Its context contains only the invocation
     (goal + bounds + step list supplied by the parent client), the child
     mode's prompt, and its own step results — it cannot see parent step
     inputs unless explicitly included in the invocation. This mirrors
     OpenCode's child-session isolation.
   - Built-in child modes (see §7): `explore` (read-only) and `summary`
     (internal, empty effective tool set). Recursion is blocked
     declaratively: an `explore` child may not create children (the child-
     creation step is denied for that mode, the same way OpenCode denies
     `task` for `general`).
   - Child tasks share the parent's single browser session (hard constraint,
     §8) and therefore share per-tab serialisation: a child step carrying a
     `tabId` joins the same per-tab promise chain as a parent step.
   - Child approvals never inherit: a child step's approval fingerprint is
     bound to the child's task id + client id, never to the parent's broker
     token.
3. **Skills, progressive disclosure** (new `extension/libs/skills/` +
   gateway `tools.skill` descriptor):
   - A skill is a record with `id`, `name`, `description`, and a body stored
     in the extension (initially: generic browser-workflow skills only —
     e.g. "read a page and extract structured data", "fill a form for
     review" — never site procedures). The catalog exposed in ListTools /
     discovery is name + description only.
   - A new gateway tool, `tools.skill`, loads a skill body by exact id, after
     a permission check; `deny` for a skill id hides it from the catalog
     *and* rejects loading, mirroring OpenCode's disclosure control.
     Supporting files are never auto-loaded; the client reads them only if
     the skill body directs it to.
   - Skills are an opt-in library, not a replacement for tool discovery:
     discovery scoring stays deterministic (exact name > tag > verb >
     category > description, full schema for top 5 only).
4. **Per-domain instructions** (new store + dashboard section):
   - Global instruction notes (dashboard-editable, stored in the extension)
     plus per-domain notes, loaded when a tab's domain matches. Ordering:
     global first, then domain notes, combined not override — OpenCode's
     `AGENTS.md` rule applied to domains instead of directories.
   - Domain notes are injected only into the environment layer for tasks
     touching that domain (Phase A layer 4), never into every task. A note
     is generic guidance about how to work (e.g. "this domain's forms
     require a preview step"), never a procedure for a specific site flow.
   - Updates to a note apply to the next task, not to a running task
     (running tasks keep their pinned policy snapshot and instruction set).

**Deliberately NOT changed:** no model calls inside Muze, no automatic
replanning, no multi-browser sessions, no change to the one-account-one-
session mapping, no weakening of approval fingerprinting or scope rules.

**Verification:**

- New tests: compaction replaces old steps in the view but raw records
  survive until prune; pruning protects the tail and instruction records and
  does not act below the reclaim threshold; child task cannot see parent
  step inputs; `explore` child cannot create children; denied skill is
  absent from the catalog and load is rejected; domain notes load only for
  matching domains and in global-then-domain order.
- Live proof (no live post required): run a parent task with an `explore`
  child on a generic page, show the child's isolated view and the parent's
  merged result; load a skill by id and show the catalog cost (name +
  description only) versus the loaded body.

### Phase D — Session unification, live dashboard, surface discipline

**Goal:** make the loop observable and the surface cheap, without changing
execution semantics again.

**Concrete changes:**

1. **Session state unification:** move gateway session records that are
   currently in-memory (discovered tools, mode) into SessionDO storage
   alongside `mcp:sessions` and `mcp:tasks`, so a gateway isolate restart
   does not silently reset a client's mode or discovered set. Keep the
   status-only rule for the task mirror; never store step inputs or page
   content in the gateway.
2. **Dashboard as a live console:** replace polling on the Tasks page with a
   push channel (service-worker → dashboard messages on task step, audit,
   and approval events; bridge `approval.resolved` broadcast already exists
   as a pattern). Polling stays as fallback. Add a loop-status view: current
   task, step index, mode, tool visibility, and instruction sources in use —
   the browser equivalent of OpenCode's TUI session status (`idle | busy |
   retry`). The dashboard remains progress-only: never step inputs, page
   content, or screenshots.
3. **Surface discipline (the MCP context-cost lesson, applied to Muze's own
   surface):** audit the initialize payload per mode and per client type;
   cap the generated tool-selection section to visible tools (Phase A) and
   the skill catalog to name + description (Phase C); keep the 50-item
   ListTools cap and the top-5 full-schema discovery rule. Every new tool or
   skill added later must justify its catalog cost in the same way OpenCode's
   docs warn that every MCP server is a per-turn context tax.
4. **Durable audit (acknowledged gap, scoped):** evaluate persisting the
   audit log beyond the service worker's in-memory 1000 events — either to
   `chrome.storage.local` with the same redaction and a bound, or to a
   gateway Durable Object with status-only records. This phase *evaluates*
   and, only if the evaluation shows redaction and size bounds hold,
   implements it. It is not promised as a free win: persisting audit widens
   the data-at-rest surface, and the current ephemeral design is a privacy
   feature as well as a limitation.

**Deliberately NOT changed:** no execution semantics, no new tools beyond
those already introduced in Phase C, no model calls, no multi-browser work.

**Verification:**

- Tests: session mode + discovered set survive a SessionDO rehydration in
  tests; dashboard receives a pushed task-step event without polling;
  initialize payload per mode is measured and does not grow when a new
  skill is added (catalog cost stays name + description).
- Live proof: dashboard shows a running task's step progress live without a
  manual refresh; a gateway restart (simulated by the user redeploying) does
  not lose a client's mode or discovered set.

## 7. Agent modes for Muze, OpenCode-style

Modes are first-class objects: each has a prompt layer, a tool visibility
set, and a permission posture. A mode is pinned per MCP session (direct
calls) or per task (task runner). Changing mode mid-task is not allowed.

| Mode | Purpose | Prompt layer | Tool visibility | Permission posture |
|---|---|---|---|---|
| `read` | Observe, extract, compare, research. The OpenCode `explore` analogue | Base + read-mode guidance: ground first, batch independent reads, never act | Read-only tools only: `observe`, `navigate` (list/open/read actions only), `data` (read domains), `tools.batch` (read-only items only), `tools.discover`, `tools.skill` (catalog + load). No `act`, `form` (fill/submit/setFile), `submit`, clipboard write, downloads, bookmarks/history writes, workflows that mutate | Scope `read:tools` suffices; any consequential call is refused at scope *and* absent from ListTools |
| `act` | Do browser work under approval: interact, fill, submit, organise tabs | Base + act-mode guidance: verify after every consequential step, fallback ladder, stale-ref rule, compensation awareness | Full registry subject to dashboard policy + OAuth scope: all unified + granular tools except `restricted` actions. `tasks.*` included (task creation is an act-mode capability) | Scope `call:tools` required for reversible/sensitive-read/consequential; approvals per §8; plan approval for multi-step consequential work |
| `plan` | Produce a plan and a dry-run preview, execute nothing. The OpenCode `plan` analogue | Base + plan-mode guidance: explore, ground, propose ordered steps with bounds and verify conditions, never execute | Read tools + `tasks.create` with `dryRun` preview + `tasks.approvePlan` (approval tool only, not execution). No `act`, `form` fill/submit, `submit`, or any mutating granular tool. Plan approval in this mode approves a *plan*, it does not execute it — execution still requires `tasks.resume` in `act` mode | Scope `read:tools` suffices for exploration; plan approval itself follows the broker-token/dashboard/elicitation paths, never a client flag |
| `explore` (child only) | Read-only subagent for a parent task: gather page state, return a summary view | Base + explore guidance: bounded reads, return only the requested summary shape | Read-only tools only, as `read`, plus no child-creation step (recursion blocked declaratively) | Same as `read`; child approvals are bound to the child task id, never inherited |
| `summary` (internal) | Condense completed task steps into a summary record (Phase C compaction) | Base + summary guidance: what was done, what is in progress, what is next, key constraints/decisions | **Empty effective tool set** (deny-all ruleset + visibility filtering, OpenCode V1 TS style) — it reads only the task record it is given, it calls no browser tool | No browser tool calls at all; no approvals needed because nothing is executed |
| `compaction` (internal) | Prune old step outputs per Phase C rules | Base + compaction guidance: protect tail + instruction records, act only above the reclaim threshold | **Empty effective tool set**, as `summary` — it operates on stored task records only | As `summary` |

Tool visibility table rules (all modes):

- A tool denied for a mode is **excluded** from ListTools for that mode. A
  direct call to it is still refused by scope/policy — visibility is not
  security.
- A tool allowed for a mode but denied by dashboard policy or OAuth scope
  for this client is also excluded (existing live-list filtering, extended
  to the static fallback list in Phase A).
- `tools.batch` in `read`/`plan`/`explore` modes refuses any item whose
  canonical granular risk is not `read-only`, per item (already the host
  rule; extend it to mode filtering at the gateway).
- `tools.discover` in every mode scores only visible tools (permission/scope
  filter first, as today, plus mode filter).

## 8. Risks and hard constraints (carried over, not renegotiated)

- **One account = one browser session.** A second extension signing into the
  same account replaces the first. Subagent child tasks, modes, and sessions
  all share that one browser; per-tab serialisation is the isolation
  mechanism, not separate browsers. Multi-browser support would require a
  new session model in DirectoryDO and is explicitly out of scope for this
  adoption.
- **Approvals are never a confirmation flag.** Broker token (single-use,
  fingerprint-bound to exact tool + canonical input + client, 120 s TTL),
  dashboard decision, or elicitation minted into a broker token — nothing
  else. This holds for modes, child tasks, skills, and plan approvals alike.
  A child task never inherits a parent approval; a skill load never
  approves a browser action; a plan approval never approves an out-of-bounds
  step.
- **Stale refs are never re-resolved.** Re-observe and mint a fresh ref for
  the same element. This rule survives every phase, including compaction
  (compacted steps must not be used to resurrect refs) and subagents (a
  child task's refs are its own, per-frame, ephemeral).
- **Tool scope is per granular action.** Unified names are a facade; scope,
  approval fingerprinting, rate-limit keys, and audit all use the canonical
  granular tool. Any new tool, skill, or child-task step must declare its
  granular mapping before it ships.
- **No per-task hardcoded prompts.** The AI builds its own brief from goal +
  observed page + discovered tool capabilities. No site-specific procedures
  appear in prompts, skills, instruction notes, or this plan's examples. A
  skill or instruction note that names a specific site flow is a bug, not a
  feature, and must be removed on sight.
- **The client loop is not controlled.** Clients may ignore modes, prompts,
  skills, and discovery, and call tools directly. The safety net is scope +
  policy + approval, not prompt compliance. Any phase whose verification
  depends on a client "behaving well" is not a verification.
- **Audit and privacy.** Audit records stay redacted (size/truncation
  metadata only, never content) and task views stay summary-only (never raw
  step inputs). Compaction and session unification must not widen these
  surfaces; Phase D's durable-audit evaluation exists precisely because
  persisting audit is a privacy trade-off, not a pure improvement.
- **Version and lineage risk.** OpenCode V1 and V2 differ (permission config
  shape, compaction config, skill IDs, `AGENTS.md` fallback). This plan cites
  the lineage per claim; any number taken from a secondary source (notably
  compaction buffer/tail constants and V2 defaults) must be re-checked
  against the current OpenCode file before being copied into Muze constants.
- **Context-cost risk in reverse.** Muze's own ListTools surface is the
  context tax for its clients. Every mode, skill, and instruction layer added
  in Phases A–D must be measured per mode (initialize payload size), or the
  adoption will make the client context problem worse while claiming to fix
  it.

## 9. First-step recommendation

**Do Phase A first, and only Phase A, as the proof of architecture.**

It is the single smallest phase that proves the core principle without
requiring a new loop, a model, or client cooperation beyond reading
ListTools:

1. Layered instruction assembly in `cloudflare/src/mcp.ts` (base + mode +
   visible-tool guidance + environment snapshot + session entries).
2. Mode-filtered ListTools (live list and static fallback alike), with
   scope/policy refusals kept as the backstop.
3. Mode recorded per MCP session in SessionDO; task mode pinned at creation.

It is gateway-only, so it needs no extension rebuild and no dashboard change.
Its verification is measurable (ListTools contents per mode, initialize
payload size before/after) and safe (no live consequential action required).
If Phase A cannot show a smaller, mode-appropriate initialize payload and a
read-mode ListTools with no acting tools, the later phases should not start —
they would be building a loop on top of a surface that has not yet been
proven to change behaviour.

## 10. What "production-ready" means for the whole adoption

All of the following, in order, before the adoption is called done:

1. **Code + tests:** Phases A–D implemented in the working tree, with the
   per-phase tests in §6 green — extension typecheck, Cloudflare typecheck,
   full extension suite, full Cloudflare suite — and the known flaky
   `gateway.e2e` socket-auth timing test reported honestly if it fails
   (it fails identically on untouched baseline; it must not be hidden or
   claimed as a regression without evidence).
2. **Push:** the working tree pushed to GitHub (the tree is not a git repo
   today; the established push procedure is the snapshot-sync route used for
   previous Muze batches, with a sync record updated).
3. **Deploy with build:** Worker deployed via `npm run deploy` (build +
   deploy) from the user's machine — never a bare `wrangler deploy`, which
   uploads a stale bundle (proven failure mode from the retest history).
   Extension rebuilt and reloaded from `dist` where extension code changed
   (Phases B–D).
4. **Live tests on all three clients:** the same proof run on ChatGPT, on
   Claude, and on Panda via the Muze connector — because Muze does not
   control the client loop, a proof on one client is not a proof for the
   others. Each proof: read-mode ListTools with no acting tools; plan-mode
   dry-run with no execution; act-mode task with checkpoint recovery and a
   recorded verify observation; child `explore` task isolation; skill load
   by id. **No live post is required for any of these proofs**; any
   consequential live action used must be on a disposable tab and reversible,
   and a test post, if ever used, is deleted by the user, never by the agent.
5. **No regressions:** the existing live-test baseline (retest history: 100
   passes after the gateway fix, last-6 fixes for drag/full-page/tabCount,
   clipboard still partial) is re-run for the affected tools, and any new
   failure is triaged as a regression before the adoption is called done.
6. **Version decision:** a version bump (0.5.0 → next) is decided only after
   live proof accumulates, as with previous Muze batches — not at code time.

## 11. Areas not verified from code (honest gaps)

- **Exact tool count:** the registry was counted as 136 tools in one track
  and the gateway scope comment cites 135 descriptors. The difference (one
  descriptor, likely a gateway-only or task-tool boundary) does not affect
  this plan, but the count should be reconciled before it is quoted as a
  fact in a release note.
- **OpenCode merge precedence:** whether session or agent wins on a direct
  permission conflict inside `PermissionNext.merge()` was not verified from
  a primary source. This plan therefore does not copy a precedence rule; it
  only copies the merged-ruleset + visibility idea.
- **OpenCode V2 numbers:** V2 compaction config values, V2 permissive
  defaults, the exact `explore` read-only tool set, and the child-session
  title format vary by version in the sources found. None of these numbers
  are adopted as Muze constants in this plan.
- **Gateway live state:** this plan was written from code, not from a live
  session. Dashboard policy mode (Unrestricted vs Balanced), live ListTools
  contents, and the current deployed Worker version were not re-verified
  here and must be checked before Phase A verification claims a live result.
- **Previous prompt work:** the tree's current prompt state (generic
  how-not-what brief, three generic prompts, no site-specific prompt) was
  verified by grep for this plan. Any earlier description of a different
  prompt state refers to superseded work, not to this tree.

## 12. Sources

- Muze code (read in full or in relevant sections for this plan):
  `cloudflare/src/mcp.ts`, `bridge.ts`, `session-do.ts`, `directory-do.ts`,
  `oauth.ts`, `config.ts`, `index.ts`, `rate-limit-do.ts`;
  `extension/src/chrome-context.ts`, `bridge-manager.ts`, `gateway-client.ts`,
  `service-worker.ts`, `host-protocol.ts`, `task-dashboard.ts`;
  `extension/libs/browser-engine/page/agent.ts`, `observer.ts`, `stitch.ts`,
  `diagnostics.ts`, `registry.ts`, `registry-factory.ts`, `executor.ts`,
  `tools/unified.ts`, `tools/page.ts`, `tools/interact.ts`, `tools/workflows.ts`,
  `tools/helpers.ts`, `summaries.ts`, `working-tab-group.ts`;
  `extension/libs/tasks/runner.ts`, `store.ts`, `types.ts`;
  `extension/libs/security/approvals.ts`, `policy.ts`, `audit.ts`;
  `extension/libs/tool-contracts/tools.ts`, `toolset.ts`, `tool-meta.ts`,
  `discovery.ts`, `action-risk.ts`, `instructions.ts` (extension copy =
  Cloudflare copy, verified by diff).
- OpenCode docs: `opencode.ai/docs/permissions`, `opencode.ai/docs/skills`,
  `opencode.ai/docs/config`, `opencode.ai/v2/docs/instructions`,
  `opencode.ai/v2/docs/skills`, `opencode.ai/v2/docs/mcp-servers`.
- OpenCode code walkthroughs (DeepWiki / deep-dives) for
  `packages/opencode/src/session/system.ts`, `session/prompt.ts`,
  `session/compaction.ts`, `session/index.ts`, `session/message-v2.ts`,
  `session/session.sql.ts`, `tool/tool.ts`, `tool/registry.ts`,
  `tool/task.ts`, `agent/agent.ts`, `storage/db.ts`.
