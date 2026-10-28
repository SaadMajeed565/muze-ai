# Muze AI — Why complex tasks still fail, and how to fix them

Version: Muze AI 0.3.0, in ~/workspace/muze-ai/
This is the improvement plan for complex tasks, not the 10-minute live
test plan. The test plan in LIVE-TEST-PLAN-10MIN.md is a separate,
later validation step. This plan is the design that would make complex
tasks completable in the first place.

## 1. The short answer

Complex tasks do not fail because one tool is slow, or because the
browser is slow. They fail because there is no task.

In 0.3.0 the system only knows single tool calls. There is no task id,
no plan, no steps, no checkpoint, no resume, and no progress. The MCP
client — Claude or ChatGPT web — has to hold the whole plan in its own
conversation, call one tool, look at the result, re-plan, call the next
tool, and remember everything that already happened. If anything breaks
that chain, the task is gone, even though the side effects from the
steps already done are still there.

A complex task is not a long tool call. It is a durable job made of
many short calls, with a plan the user approved, checkpoints after
every step, and a way to resume. That job does not exist yet. This
plan builds it, inside the extension, because the extension is the
source of truth for the browser.

## 2. What is still holding complex tasks back, in order

### 2.1 No task object — the main blocker

- Evidence: no task id, plan, steps, checkpoint, or resume anywhere
  in the extension, gateway, or tool contracts. A task exists only as
  text in the client's conversation.
- What happens in a real task: research 10 pages, collect links,
  organise tabs, fill a form, download a file. After step 6 the client
  loses context, times out, or the user closes the tab. Steps 1 to 5
  are done, but there is nothing to resume from. The client must start
  again, and may redo steps that should not be redone.
- Fix: a task object that lives in the extension, not in the client.

### 2.2 Per-step approval, not plan approval

- Evidence: every consequential step needs its own approval token,
  dashboard decision, or elicitation decision. ApprovalBroker TTL is
  120,000 ms. Dashboard wait is capped at 120,000 ms. The code itself
  notes MCP clients may time out earlier than 120 seconds.
- What happens: a 20-step task needs up to 20 approvals. If the user
  is not watching constantly, one approval expires, that step fails,
  and the whole chain stalls. The user also gets approval fatigue and
  starts approving without reading, which is worse.
- Fix: approve the plan once, with clear bounds. Only steps outside
  those bounds ask again.

### 2.3 State disappears on restart, disconnect, or eviction

- Evidence: approvals, audit, and client registry are in-memory.
  AuditLog is bounded in memory, 1,000 events in the service worker.
  Policy does survive, because it is stored in `chrome.storage.local`
  under `muze.policy`. Approvals and task state do not.
  The service worker can be suspended after about 30 seconds idle,
  kept alive only by offscreen pings every 20 seconds and alarms
  every 30 seconds. The bridge can drop. The Session Durable Object
  can be evicted, and on cold start it only replays the initialize
  handshake, not a task.
- What happens: restart, bridge drop, or eviction loses the plan and
  the progress, but not the side effects. The system cannot tell the
  user what is done and what is left.
- Fix: checkpoint every step to persistent storage, before the next
  step starts, and load it back on restart.

### 2.4 No idempotency — retry can do the same thing twice

- Evidence: the protocol defines `clientOpId`, a client-supplied
  correlation id, but the executor does not deduplicate on it. It is
  a field definition, not a safety check.
- What happens: a step times out, but actually clicked, submitted,
  or created something. The client retries the same step and it
  happens twice. This is the most dangerous failure in a complex task,
  because it looks like a recovery and is actually a duplicate.
- Fix: one idempotency key per step, checked before execution, with
  the stored result returned on a repeat instead of re-executing.

### 2.5 One timeout per call, no total budget, no progress

- Evidence: executor default timeout is 30,000 ms per call. Bridge
  request timeout is 60,000 ms. There is no task-level time budget,
  no progress event, and no polling endpoint. Batch is read-only only,
  maximum 8 calls, and refuses risk above read-only even if the
  gateway asks.
- What happens: a long task is really 20 to 50 separate calls, each
  under 30 seconds, but the client must stay in the same turn and
  keep the conversation alive for all of them. If the client has a
  turn limit, or stops to ask the user something, the task has no
  independent life of its own. The user also has no progress bar, no
  "step 7 of 20", and no way to ask "how far did it get".
- Fix: a task runs in the extension, independent of one client turn.
  The client polls for progress, and can resume in a later turn.

### 2.6 No atomicity, no rollback, partial results are not saved

- Evidence: writes are sequential single calls. Workflows in 0.3.0
  return partial results to the client, but they do not save that
  partial state in the extension. There is no undo list and no
  compensation list.
- What happens: step 7 fails, steps 1 to 6 are done, and the task
  ends in an unclear state. The user does not get a clean report of
  what is done, what is undone, and what needs manual cleanup.
- Fix: every task ends in a clear state — done, failed, cancelled,
  or partial — with a done list, an undone list, and a best-effort
  compensation list. Never claim complete if it is partial.

### 2.7 Grounding breaks over long tasks — secondary, not the blocker

- Evidence: refs now correctly fail when stale, which is safer, but
  a long task must re-observe after every page change. Outputs are
  bounded, screenshots are stripped from size calculations, and
  capture can switch the active tab. CDP fast paths are top-frame
  only.
- What happens: a page changes, a ref goes stale, the agent loses
  track and loops, or acts on the wrong element. This makes long
  tasks brittle, but it does not cause the task to disappear. Fix it
  after the task object exists, not instead of it.

## 3. The design: a durable task engine in the extension

Keep the architecture from the earlier recommendation. Do not move
execution truth to the cloud.

- Extension = truth for browser state, what tools are allowed now,
  approvals, task plan, task progress, and audit decisions.
- Gateway = truth for who the user is, which session belongs to
  which account, OAuth client validity, token scope, and revocation.
  The gateway only mirrors task status. It never executes a step.
- Shared contracts = truth for tool definition, parameters, and
  version. Both sides pin the same version, and fail closed on
  mismatch. Adding task tools is additive, not breaking.
- Dashboard = never truth, only a view. It shows progress, current
  step, done and failed steps, and pause, resume, and cancel buttons.

### 3.1 Task model

One task, stored in `chrome.storage.local` under a new key, following
the existing `muze.*` storage pattern used for policy and bridge
settings, with the same legacy migration care if a key is ever renamed:

```
task {
  id,                 // e.g. task_01... — stable, returned to client
  goal,               // plain text goal, as the user stated it
  clientId,           // which MCP client created it
  browserSessionId,   // which browser this task is bound to — never
                      // route a task by user alone, only by session
  status,             // created, approved, running, paused,
                      // waiting_approval, done, failed, cancelled, partial
  plan,               // ordered steps, see below
  bounds,             // plan-level approval bounds, see 3.3
  totalBudgetMs,      // task-level budget, separate from per-step timeout
  createdAt, updatedAt, completedAt,
  correlationId,      // same id in gateway, bridge, executor, audit
  resultSummary       // short summary only — never full page content,
                      // never screenshots, never secrets
}

step {
  index,
  tool,               // canonical tool name
  input,              // canonical input, validated by the same schemas
  idempotencyKey,     // hash(taskId + stepIndex + canonical input)
  state,              // pending, running, done, failed, skipped, waiting_approval
  attempts,           // with last error and whether it is retryable
  outputSummary,      // small summary, not the full output
  startedAt, finishedAt,
  compensation        // best-effort undo, e.g. close tab, navigate back,
                      // delete a download — or "none, manual cleanup"
}
```

Storage rules, to stay inside `chrome.storage.local` limits:
- Store metadata, summaries, and small outputs only.
- Never store full page content, screenshots, passwords, tokens, or
  file contents in a task record.
- Cap steps per task, for example 100, and cap total stored tasks,
  for example 50, with completed tasks pruned after 7 days unless
  the user pins one.
- For larger outputs, keep a reference to the existing file store or
  audit entry, not a copy in the task record.

### 3.2 New MCP tools, additive

These are new tools in the shared registry, in addition to the
existing 129 tools. They do not change existing tools.

- `tasks.create` — create a task from a goal and a plan, or from a
  goal alone with `autoPlan: true` if the client proposes the plan
  and the extension validates it. Returns task id and plan.
  With `dryRun: true` it only validates and previews, see 3.4.
- `tasks.get` — get one task: status, progress, current step, done
  list, failed list, and next action. This is the polling endpoint.
- `tasks.list` — list tasks for this browser session, newest first,
  with status and progress only, no full outputs.
- `tasks.resume` — resume a paused, interrupted, or waiting task
  from its last checkpoint. Never redoes a done step, see 3.5.
- `tasks.pause` — pause a running task cleanly, after the current
  step finishes or times out.
- `tasks.cancel` — cancel a task, run best-effort compensations,
  and report done versus undone. Cancel is not delete.
- `tasks.approvePlan` — approve a plan with bounds, see 3.3. A plan
  is not executed until it is approved, unless every step is
  read-only or reversible under the current policy and no approval
  is required for any of them.

Execution rules:
- Sequential by default. One step at a time, in plan order.
- Parallel only for read-only, independent steps, maximum 4 at a
  time, the same limit workflows already use for mapPool. Never
  parallelise consequential steps unless the plan explicitly marks
  them independent and the user approved that.
- Every step goes through the existing executor, policy, and
  approval gates. The task engine does not bypass policy. It only
  adds persistence and ordering around it.
- Per-step timeout is separate from total budget. A step can time
  out at 30 seconds by default, or at the step's own timeout, while
  the task as a whole can have a budget of, for example, 10 minutes,
  30 minutes, or 1 hour, set at creation.
- The task runner lives in the extension service worker, but its
  state lives in storage. If the service worker restarts, the runner
  reloads the task from storage and continues from the checkpoint,
  it does not start a new task.

### 3.3 Plan-level approval — approve the plan once, not every step

When a task is created, the user approves the plan, not each step
one by one, with explicit bounds:

- Allowed tool groups and risk levels, for example read-only and
  reversible only, or consequential only for the listed tools.
- Allowed domains, as a list or glob, for example only the domains
  in the plan. Any new domain pauses the task and asks again.
- Allowed actions: for example, no purchases, no payments, no
  external submits without preview, no password or file inputs,
  no clipboard reads, no downloads over a set size.
- Maximum steps, maximum attempts per step, and total budget.
- Stop conditions: any unexpected error, any new domain, any price
  or payment field, any approval-required tool outside the bounds,
  or any step that changes the goal. On any stop condition, the task
  pauses, it does not guess and continue.

How it works with the existing approval system:
- Plan approval is stored with the task, with an expiry, for example
  the task lifetime or 24 hours, whichever is shorter. It is not a
  client-supplied flag. It is a broker approval token, a dashboard
  decision, or a verified elicitation decision, the same three
  sources that already count as approval in 0.3.0.
- A step inside the bounds uses the plan approval and does not ask
  again. A step outside the bounds pauses the task and asks for a
  step approval, with the exact tool, input summary, and reason it
  is outside the bounds.
- Denying a step pauses the task and marks that step failed, with
  the reason recorded. It does not cancel the whole task silently,
  and it does not approve anything else.
- The dashboard shows approvals grouped by task, not just by client,
  so the user can see which plan they approved and what is left.

### 3.4 Dry-run first — preview the whole plan before it runs

Before any side effect, `tasks.create` with `dryRun: true` returns:

- The validated plan, step by step, with canonical tool names and
  parameters.
- The risk level of each step, and which steps need approval.
- The domains, tabs, and files the plan will touch.
- The estimated step count and total budget.
- Any step that cannot be validated, for example an unknown tool,
  an invalid parameter, or a step that would be rejected by policy.

Dry-run executes nothing, writes nothing, clicks nothing, and
creates no task record beyond the preview itself. The user can
correct the plan before it is created for real. This is the whole
plan check that single calls cannot do.

### 3.5 Idempotency and safe retry — never do the same step twice

- Before executing a consequential step, the engine looks up its
  idempotency key in the task record.
- If the key is already marked done, it returns the stored output
  summary and does not re-execute. No second click, no second submit,
  no second creation.
- If the key is marked failed with a retryable error, it retries up
  to the plan's attempt limit, with backoff, and only if the step
  is still inside the approved bounds.
- If the key is marked failed with a non-retryable error, or the
  step was denied, it does not retry automatically. It pauses the
  task and reports the failure.
- `clientOpId`, if the client sends one, is stored alongside the
  step key for correlation, but it is not the safety check by itself.
  The task's own key is the safety check, because it is derived from
  task id, step index, and canonical input, not from a value the
  client can reuse or forget.

### 3.6 Checkpoint, resume, and progress — the core loop

After every step, in this order, without exception:

1. Record the step result or error in memory.
2. Persist the whole task record to `chrome.storage.local`.
3. Write an audit entry with task id, step index, tool, decision,
   and outcome summary. No tool inputs, no screenshots, no secrets.
4. Emit a progress event to the dashboard, and to the gateway as a
   status mirror only, with task id, status, step index, total steps,
   and a short message.
5. Only then start the next step.

On service worker restart, bridge reconnect, or Durable Object
eviction, the task is loaded from storage in status paused or
interrupted, with its last checkpoint intact. `tasks.resume`
continues from the next pending step. It never redoes done steps,
because of 3.5, and it never loses the done list, because of this
checkpoint order.

Progress the user can see, in the dashboard and through `tasks.get`:
- Task goal, status, and progress as step X of Y.
- Current step tool and a short description, not the full input.
- Done steps, failed steps, and the next action, for example
  "waiting for approval", "paused", "ready to resume".
- Final report on done, failed, cancelled, or partial: what is done,
  what is undone, what compensations ran, and what needs manual
  cleanup.

### 3.7 Compensation and partial completion — honest endings

A task can end in four honest states, never as a false "done":

- Done: every step done, final summary matches the goal.
- Failed: a step failed and cannot be retried, with the error and
  the step index. Earlier steps stay done and are listed.
- Cancelled: user cancelled, best-effort compensations ran, done
  versus undone is listed.
- Partial: some steps done, some failed or skipped, with a clear
  report. The client must not present a partial task as complete.

Compensation is best-effort, not a transaction rollback, and the
plan must say so honestly:
- Closing a tab the task opened, navigating back, deleting a file
  the task downloaded, or removing a bookmark it created — these
  can be compensated.
- An external submit, a sent message, a purchase, or a created
  account cannot be reliably undone by the browser. For those steps,
  the plan must require preview and approval, and the final report
  must list them as done and not undoable, with manual cleanup
  steps if any exist.

### 3.8 Grounding hardening for long tasks — after the task object

Once a task can survive, make it less brittle:

- Before a consequential step, re-observe the target page and
  re-validate the ref. If the ref is stale, pause that step, re-
  observe, and only continue if the new observation matches the
  plan's expectation. Do not fail the whole task on one stale ref,
  and do not re-resolve to a different element silently.
- Store a small observation summary per step, for example page
  title and URL, not the full page, so the next step can check it
  is still on the right page.
- Pin the tab per step where the plan requires it, instead of
  relying on the active tab. Capture and CDP actions that switch
  tabs must restore the task's tab afterwards, or record the switch.
- Cap output per step and summarise long outputs before storing
  them in the task record, so a 50-step task does not blow up
  storage or the client's context.

## 4. Build order — what to build first, and why

Build in this order. Each phase is shippable on its own, and each
phase makes the next phase safer. Do not build dashboard polish
before persistence, and do not build parallel execution before
idempotency.

### Phase 0 — Durable task, sequential runner, resume (core)

- Task store in `chrome.storage.local`, task model from 3.1.
- `tasks.create`, `tasks.get`, `tasks.list`, `tasks.pause`,
  `tasks.resume`, `tasks.cancel`, all through the existing executor
  and policy, sequential only.
- Checkpoint after every step, audit with task id and step index,
  correlation id from gateway to bridge to executor to audit.
- Gateway mirrors task status only, routes by browser session id,
  never by user alone.
- Tests: create, run, kill the service worker mid-task, reload from
  storage, resume from checkpoint, cancel mid-task, list tasks.
- Exit test: a 10-step read-only task, interrupted at step 5 by a
  service worker restart, resumes at step 6 with no duplicate work.

### Phase 1 — Plan approval, dry-run, idempotency (safety)

- Plan bounds from 3.3, stored plan approval, step approval only
  outside bounds.
- `tasks.create` with `dryRun: true`, and `tasks.approvePlan`.
- Idempotency keys from 3.5, checked before every consequential step.
- Tests: plan approval inside bounds needs no second approval,
  outside bounds pauses, denied step pauses, expired plan approval
  pauses, duplicate retry returns stored result without re-executing,
  dry-run executes nothing.
- Exit test: a 10-step form task with one plan approval, one outside-
  bounds step that pauses and asks again, and one deliberate retry
  that does not submit twice.

### Phase 2 — Progress, dashboard, compensation (visibility)

- Dashboard task panel: progress, current step, done and failed
  lists, pause, resume, cancel, and final report.
- Progress events to dashboard and gateway status mirror.
- Compensation list per step, best-effort, with honest done versus
  undone reporting on cancel and partial.
- Tests: dashboard shows the same progress as `tasks.get`, cancel
  runs compensations and reports undone, partial is never reported
  as done.
- Exit test: a task cancelled at step 7 reports steps 1 to 6 done,
  steps 8 to 10 undone, and compensations run or listed as manual.

### Phase 3 — Parallel read-only, grounding hardening, multi-browser

- Parallel execution only for read-only independent steps, maximum
  4, with per-step tab pinning.
- Re-observe before consequential steps, stale-ref pause and
  re-observe, output summarisation per step.
- Multi-browser per account: gateway routes a task strictly by
  browser session id, user picks the target browser in the dashboard
  or in the task creation, and a task never moves to a different
  browser on its own.
- Tests: parallel read-only steps complete in any order without
  interfering, stale ref pauses instead of failing the task, task
  bound to one browser session does not run on another.
- Exit test: a 20-step research and organise task, with a page
  change mid-task, completes with a correct final report.

### What not to build

- Do not move task execution to the gateway or to Cloudflare. The
  gateway cannot see tabs, DOM, or policy, and moving execution
  there would leak page data and still fail on Chrome APIs.
- Do not move policy to the gateway. Policy stays in the extension.
  Gateway scope checks stay a coarse first gate only.
- Do not cache task plans or tool lists for a long time. The 5
  second tool-list cache is already the limit. A task must re-check
  policy and approval at execution time, not at plan time only.
- Do not add a server-side allow that can override an extension
  deny. If a company policy is ever needed, it must be a deny-only
  layer in both places, not an override.
- Do not claim true rollback for external actions. Report them as
  done and not undoable.

## 5. Contract and versioning

- Adding task tools is additive. Existing tools, parameters, and
  approval rules do not change in this plan.
- Bump the tool registry to 2.1.0 for the new tools, with the shared
  contracts synced by the existing sync script and checked by the
  existing check script, on both extension and gateway sides.
- Old clients that do not know task tools ignore them and keep
  working with single calls. New clients can use tasks, and can
  still use single calls for simple work.
- A task created by one client belongs to that client and that
  browser session. Another client cannot resume, cancel, or approve
  it unless the user explicitly transfers it in the dashboard.

## 6. How we prove it works — three example complex tasks

Do not prove this with unit tests alone. Unit tests prove the store
and the runner. Live tasks prove the whole chain.

1. Research and organise, read-only, 20 steps:
   Read 10 pages, collect their titles and links, organise the tabs
   into groups, and save a summary. Interrupt it at step 10 by
   restarting the service worker, resume, and check no page is read
   twice and no tab is grouped twice.
2. Multi-page form with preview and approval, consequential, 10 steps:
   Fill a test form across 2 pages, show a preview, get one plan
   approval, submit only after preview, then report the submission
   result. Add one outside-bounds step on purpose, and check it
   pauses and asks again instead of continuing.
3. Collect, download, and organise, mixed, 15 steps:
   Collect links from 5 pages, download 3 test files, organise tabs,
   and save a file list. Cancel it at step 10, and check the final
   report lists done, undone, and compensations correctly.

Pass for all three: correct final report, no duplicate consequential
action, no silent partial reported as done, and resume after
interruption works without redoing done steps.

## 7. Risks and honest limits, even after this plan

- A task engine does not make a slow page fast. A step that takes
  over 30 seconds will still time out, but now the task can pause,
  report that step, and resume, instead of disappearing.
- A task engine does not undo an external submit, purchase, or sent
  message. It only prevents duplicates and reports honestly.
- A task engine does not remove client turn limits. A client can
  still stop in the middle of a turn. The difference is that the
  task now survives in the extension, so the next prompt can call
  `tasks.resume` and continue, instead of starting again.
- A task engine does not fix a page that changes its layout mid-task.
  It only pauses on a stale ref and asks for a re-observation,
  instead of acting on the wrong element.
- Storage is limited. A task record must stay small, with summaries
  only, or it will hit `chrome.storage.local` limits and fail to
  checkpoint. That is why full page content and screenshots are
  never stored in a task record.

## 8. Other things that also need fixing for complex tasks

The task engine in section 3 is the main fix, but it is not enough
on its own. The audit below, checked against the 0.3.0 code on
2026-10-28, found other gaps that will break a complex task even
after the task engine exists. They are grouped by priority. Do not
treat the "later" items as blockers for a first single-user task,
but do not claim complex tasks work in general until the
"must fix" items are done.

### 8.1 Must fix — a task engine alone will still break without these

1. No tab or task lock, and no user-interference detection.
   - Evidence: the only locks are per-tab capture locks and per-tab
     injection locks in chrome-context, CDP reference counting per
     tab, and a lock for session save. There is no executor queue
     per tab, no task ownership of a tab set, and no lock for
     consequential actions on a tab.
   - What breaks: two tasks, two clients, or a task plus the user
     acting on the same tab at the same time can interleave clicks,
     navigations, and captures. The user closing a tab, navigating
     away, or switching windows mid-task is not detected as a task
     event, so the task can continue on the wrong page.
   - Fix: serialise consequential actions per tab. A task pins its
     tab set at creation. If a pinned tab is closed, navigated
     externally, or taken over, pause that task, do not continue
     blindly. Capture already switches the active tab and restores
     it, but a task that captures often will still flicker the
     user's window, so capture in a task should be batched and
     minimised.

2. Bridge disconnect leaves a step in an unknown state.
   - Evidence: on bridge close, the gateway fails every pending
     request with CONFLICT, retryable, and the extension host
     disposes in-flight work with "Bridge closed". Neither side
     knows if the browser actually completed the step.
   - What breaks: a task that retries a timed-out or disconnected
     step can duplicate it, even with an idempotency key, because
     the first attempt may never have been recorded as done.
   - Fix: on bridge close, mark the step unknown, not failed. Before
     any retry, re-observe the page and check whether the effect
     already happened, for example the tab already navigated, the
     form already filled, or the file already downloaded. Only then
     mark it done or retry it. This check is part of the task
     runner, not an optional client behaviour.

3. Rate limits and fail-closed errors must pause, not fail, a task.
   - Evidence: extension RateLimiter is 120 burst, 20 per second,
     per client and tool. Gateway limits are per IP: /mcp 300 per
     minute, /bridge 60 per minute, and a limiter error returns 503
     fail-closed. A task with many calls, or several clients behind
     one home IP, can hit these.
   - What breaks: a task that treats a 429 or 503 as a step failure
     will fail a task that only needed to wait. A task that retries
     immediately will hit the limit again and loop.
   - Fix: the task runner must respect retryAfterMs, back off, and
     pause the task on 429 or 503, not mark the step failed. Rate
     limit errors are a wait, not a result.

4. Error classification is too thin for safe retry.
   - Evidence: ToolErrorException defaults retryable to false.
     Only timeout, rate limit, and bridge conflict or timeout are
     marked retryable in the code paths checked. Permission denied,
     invalid input, approval denied, tab closed, and page changed
     are not given a consistent retry policy.
   - What breaks: a task runner that retries every failure will
     loop on permission or invalid input. A runner that retries
     nothing will fail on a transient network or tab problem.
   - Fix: a three-way taxonomy, enforced in the runner: retryable
     (timeout, rate limit, bridge conflict, transient network),
     non-retryable (permission denied, invalid input, approval
     denied, policy blocked), and unknown, meaning re-observe first
     and only then decide. Unknown must never be retried blindly.

5. Per-step timeout is global, not per task or per step.
   - Evidence: policy defaultTimeoutMs is 30,000 ms for every tool.
     Some sync tools accept their own timeoutMs, but most tools do
     not, and the bridge caps any call at 60,000 ms.
   - What breaks: a task that needs a slow step, for example a
     long page load or a large download, cannot ask for a longer
     step timeout, and a task that needs fast steps cannot ask for
     a shorter one.
   - Fix: per-step timeoutMs in the task plan, validated against
     the 60 second bridge cap. Long waits must be split into
     polling steps, for example check every 5 seconds, not one
     60 second wait that will time out anyway.

6. Session eviction can kill a running task's client.
   - Evidence: SessionDO allows maximum 32 MCP sessions per browser
     session, and evicts the oldest when a caller keeps opening
     sessions without closing them. Eviction is silent.
   - What breaks: a long task's client session can be evicted by
     other clients opening sessions, and the task client must
     re-initialise. If the task is bound to the old session id,
     resume must be explicit, not assumed.
   - Fix: pin sessions that own a running task, so they are not
     evicted first. If eviction still happens, the task pauses with
     a clear "client session evicted, call tasks.resume" state,
     and resume re-binds to the new session after re-checking
     client identity and OAuth scope.

7. Policy, scope, or token changes mid-task are not handled.
   - Evidence: executor re-checks policy at each call, which is
     correct, but the task plan does not record the policy version
     it was approved under. OAuth scope is enforced at CallTool,
     but a task resumed by a different client or with a different
     scope is not covered.
   - What breaks: the user changes permission level, turns on the
     kill switch, blocks a domain, or rotates a token mid-task,
     and the task either fails step by step with no explanation,
     or continues under a plan approval that no longer matches
     the current policy.
   - Fix: record policy version, permission level, client id, and
     OAuth scope at plan approval. Re-check them at every step.
     On any change, pause the task and report the change, do not
     widen or narrow the plan silently. A task can only be resumed
     by the same client, with the same or a stricter scope, never
     by a weaker or different client.

### 8.2 Should fix — complex tasks will be slow, confusing, or lossy without these

8. Tool discovery friction for tasks that need many tools.
   - Evidence: by default only a core set is shown in ListTools.
     Non-core tools need tools.discover, which returns at most 12
     results by keyword scoring on name, title, and description.
     ListTools live fetch fails closed to an empty list after a
     5 second cache if the browser is briefly away.
   - What breaks: a complex task that needs many granular tools
     wastes calls discovering them, can miss a tool because it
     scored outside the top 12, or sees an empty tool list during
     a brief disconnect and thinks no tools exist.
   - Fix: for task creation, allow the planner to get the full
     tool list once, or discover by category as well as keyword,
     with a higher, explicit limit. Keep the core set for simple
     chat, but do not make task planning pay a discover call per
     tool. Also, a brief ListTools failure should return the last
     known list with a stale flag, not an empty list, for task
     planning only, while execution still fails closed.

9. No progress, no audit export, no per-task history.
   - Evidence: MCP capabilities are tools, prompts, and elicitation
     only. No progress notifications were found in the gateway or
     session code. AuditLog is bounded in memory at 1,000 events
     in the service worker, with no export. Dashboard Activity is
     a manual refresh list, with approvals grouped by client, not
     by task.
   - What breaks: a 50-step task can push early audit events out
     of memory, so after a restart nobody can prove what happened
     in steps 1 to 10. The user has no progress bar, no auto-
     refreshing task view, and no file to send for debugging.
   - Fix: tasks.get as the polling endpoint, dashboard auto-refresh
     for the task panel, and a durable, per-task audit record in
     storage or IndexedDB, with an export as JSON. Gateway audit
     mirror, if added, must be metadata only: task id, step, tool,
     decision, outcome, no inputs, no screenshots, no page content.
     This is the same durable approvals and audit work proposed
     in Phase 1 of the architecture recommendation, now required
     for tasks, not just for approvals.

10. Truncated outputs are not handled as a task problem.
    - Evidence: executor bounds output by maxOutputChars and sets
      truncated true, with a note to re-call with a narrower scope
      or a paged offset. Page text and tables have their own
      paging and truncation flags.
    - What breaks: a task that collects data across pages can
      silently use a truncated result as if it were complete, and
      miss rows, links, or text.
    - Fix: the task runner must treat truncated true as "not done
      yet" for data-collection steps, and automatically page or
      narrow the scope until the step returns complete, or mark
      the step partial with the exact missing range recorded.

11. File handling for tasks is unisolated and unencrypted.
    - Evidence: file store is IndexedDB named uabb-files, stated
      in its own header as unencrypted with no per-client isolation.
      Upload cap is 15,000,000 base64 characters, setFile cap is
      35,000,000, unified to match granular in 0.3.0.
    - What breaks: files collected by one task or one client are
      visible to another, and a task that collects many files has
      no per-task namespace, no cleanup, and no encryption decision.
    - Fix: per-task file namespace, per-client isolation, and a
      cleanup rule on task completion or cancellation. Encryption
      itself is a separate user decision already open from 0.3.0,
      but isolation and cleanup are required for tasks even before
      encryption is decided.

12. No prompts, resources, or task-as-resource support.
    - Evidence: MCP capabilities declare prompts, but no prompt
      handlers were found in the task-relevant code, and no
      resources are declared. A task can only be reached by a tool
      call, not read as a resource.
    - What breaks: a client that wants to read task state, or a
      user who wants a standard task template, has no standard
      MCP way to do it, so every client invents its own task
      format and loses compatibility.
    - Fix, later: add a task resource, for example task://<id>,
      read-only, with status and progress only, and a small set of
      task prompt templates for common complex tasks, such as
      research and organise, or fill and preview. Do not add this
      before the task tools themselves work.

### 8.3 Later, for scale — not blockers for one user, one browser

13. Single Directory Durable Object and one Session Durable Object
    per browser session. This is fine for personal use and for one
    task at a time, but it is a bottleneck and a single point of
    failure for thousands of users or many parallel tasks. Shard
    by account or by browser session, add tenant isolation, and
    add an admin view only when scaling, not for the first task
    engine.
14. No chaos or soak tests for long tasks. Unit tests are mock and
    jsdom, gateway tests are Miniflare with a fake host. There are
    no tests for killing the service worker mid-step, evicting the
    Session Durable Object mid-task, disconnecting the bridge
    mid-batch, or running two tasks on the same tab. Add those
    chaos tests in Phase 0 and Phase 1, or the task engine will
    pass unit tests and fail in real use.
15. CDP and capture costs in long tasks. CDP detaches after every
    call, which is safe but costs an attach round trip per call,
    and full-page capture switches the active tab and restores it.
    A task that captures on every step will be slow and will
    flicker the user's window. Batch captures, capture only on
    demand or on failure, and prefer DOM snapshots over screenshots
    for verification in long tasks.

### 8.4 Revised first build, with these fixes included

The recommended first build from section 9 stays the same, plus
three items from 9.1 that cannot wait, or resume will be unsafe:

- Durable task, sequential runner, checkpoint after every step,
  resume from checkpoint.
- Idempotency per step, plus unknown-step handling on bridge
  disconnect: re-observe before retry, never retry blindly.
- Per-tab serialisation for consequential steps, and pause on
  pinned tab close or external navigation.
- Rate limit and fail-closed pause, not failure, with retryAfter
  backoff.
- Policy, client, and scope re-check at every step, pause on change.

Plan approval, dry-run, dashboard progress, and audit export come
immediately after, in Phase 1 and Phase 2, because a task that
survives but cannot be approved as a plan, or cannot be inspected,
is still not a complex task a user can trust.

## 9. Recommended first step, if you want one thing first

Build Phase 0 and the idempotency check from Phase 1 together, as
one first build: durable task, sequential runner, checkpoint after
every step, resume from checkpoint, and no duplicate consequential
step on retry. That alone turns a complex task from "gone on any
break" into "paused, resumable, and safe to retry".

Plan approval and dashboard polish come after that, because a
beautiful approval screen for a task that still disappears on
restart does not help.
