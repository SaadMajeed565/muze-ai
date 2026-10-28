# Browser-agent instructions + DOM grounding plan

Date: 2026-10-28
Status: PLAN ONLY — no code changed, no push, no deploy, no live calls in this batch.
Problem it solves: the Instagram test post worked, but only after label clicks
misfired, a screenshot-coordinate loop, and a wrong-element click (Live video
instead of Post). ChatGPT stopped at the same two blockers. Tools are fine;
grounding and execution discipline are not.

## 1. Root cause, proved on Instagram

Muze's current page agent builds its own accessibility tree from the DOM
(`extension/libs/browser-engine/page/agent.ts`, `snapshot` / `a11yTree` case).
Its own comment says: Chrome's real AX tree is only reachable through the
debugger, which Muze never attaches.

Its `implicitRole()` returns a role only for a small tag list
(`a`, `button`, `input`, `textarea`, `select`, `img`, headings, `form`,
`table`). Everything else — `div`, `span`, the elements Instagram actually
uses for its Create menu — gets role `""`.

Its snapshot filter then drops non-interactive roles when
`interactiveOnly` is true (the default). Result on Instagram: the
accessibility tree returned essentially one node (Messages), even though
the page text/links clearly showed Create, Post, Live video, Ad.

Consequences, all observed live:
- `act` click by label "Post" matched the wrong element (the New post
  toggle, same ref) and closed the menu.
- `page.find` / `dom.find` for "Post" returned nothing, because find
  searched the a11y label space, not DOM text.
- The agent fell back to screenshots + visual grounding + pixel
  conversion. Screenshot height changed between shots (633 vs 689),
  so the first conversion was ~40px low and clicked Live video.
- "Next" and "Done" label clicks failed with "target not found".
- Every `observe` returned the whole feed text, with dialog state
  buried at the end.

None of this is a tool failure. `forms.setFile` with a stored fileId
worked first try, CDP clicks worked once the coordinates were right,
and Instagram confirmed "Post shared". The failure is grounding:
the agent could not see the thing it needed to click, in a form
it could act on.

## 2. What Cursor / Playwright actually does (web research)

Cursor does not publish a separate proprietary browser engine. In
Cursor, browser automation is done through the Playwright MCP pattern:
configure `npx @playwright/mcp@latest` in Cursor Settings → MCP.
The pattern that makes it work is Playwright's, and Muze should copy
the pattern, not the brand:

- Snapshot mode is the default. It uses accessibility snapshots for
  better performance and reliability; vision mode (screenshots + XY
  coordinates) is the fallback, for computer-use models only.
- A snapshot gives every interactive element a stable `ref`.
  Clicks take a human-readable element description *plus* the exact
  ref from the snapshot. That pair is the permission and the target.
- The snapshot is the accessibility tree, not pixels and not raw
  HTML. That is why it is fast, lightweight, and deterministic,
  and why it does not need a vision model in the default mode.
- Agent-browser style tools add: compact AX snapshots with
  `@e1`-style refs, interactive-only filtering, `snapshot --delta`
  updates, refs that survive same-document changes, and annotated
  screenshots only as a secondary mode.

Muze already has the right shape (observe → ref → act → re-observe),
but its snapshot is a hand-built DOM tree with a narrow role list,
not a real AX tree, and its refs are not backed by a merged
DOM + AX + geometry record. Fix that, and the Cursor/Playwright
pattern drops in with no new tool surface.

## 3. The fix: one merged snapshot (mix AST + AX + DOM)

Do not replace AST with AX, and do not replace AX with screenshots.
Merge all three, per DOM node, into one node record. A node that
appears in any source is kept; sources are labelled, not hidden.

### 3.1 Sources, in precedence order

1. **Chrome AX tree via CDP, when available.**
   `Accessibility.getFullAXTree` through the existing CDP session
   (Muze already uses CDP for click/move/type/press/scroll/drag/
   screenshot). This is the closest thing to Playwright's snapshot:
   real roles, names, values, checked/disabled/focused, ignored
   subtrees pruned by Chrome itself.
   Risk, stated plainly: attaching the debugger is exactly what
   Meta may flag (the earlier Instagram New-post → Facebook
   login_sync redirect was automation-specific, and manual posting
   worked). So AX is attempted, never assumed: if the page
   refuses, times out, or the browser reports debugger
   interference, the snapshot falls back to sources 2 + 3 and
   says so in the response (`ax: "unavailable", reason`).
   Never fabricate an AX node from a DOM guess and label it AX.

2. **DOM AST (current Muze tree, kept).**
   Tag, text, selector path, parent/children, shadow-DOM
   traversal (already in the agent), iframe `frameId`
   (already fixed to 0 for the main frame), form fields,
   headings, links, tables. This is the structure AX alone
   does not give, and it is what makes a selector fallback
   possible.

3. **Interactive heuristic layer (the missing piece).**
   An element counts as actionable if ANY of these hold:
   - explicit `role`, or a tag in button/a/input/select/
     textarea, or `contenteditable`;
   - `tabindex >= 0`, `aria-label` / `aria-labelledby`, or
     an associated `<label>`;
   - computed `cursor: pointer`, or an ancestor that is
     itself actionable (Instagram menu rows are divs
     inside a clickable container);
   - visible, non-zero bounding box, not `display: none`,
     not `visibility: hidden`, not `aria-hidden="true"`.
   Record the reason: `clickableReason: "role" | "tag" |
   "tabindex" | "cursor" | "ancestor"`, plus
   `clickableConfidence`. A div with text "Post",
   cursor pointer, and a visible box is then a first-class
   clickable node, even with role `""`.

### 3.2 The merged node record

Every node returned by `observe` / `page.snapshot` /
`page.accessibilityTree` should carry, at minimum:

```
{
  ref,            // stable, existing refFor() + data-muze-ref, never re-minted
  role,           // from AX if present, else implicitRole, else ""
  name,           // AX name, else accName(): aria-label, labelledby, label, alt, title, text
  text,           // visible text, trimmed, bounded
  tag, selector,  // DOM identity for selector fallback
  bbox,           // viewportX, viewportY, width, height, from getBoundingClientRect
  visible, clickable, clickableReason, clickableConfidence,
  source,         // "ax" | "dom" | "ax+dom" | "heuristic"
  frameId,        // 0 = main frame, else subframe id
  disabled, checked, focused, value  // where applicable, sensitive fields still redacted
}
```

Dedupe by DOM node (the existing WeakRef registry), never by
text: two "Post" strings on one page are two different refs.
A stale ref still fails as STALE_ELEMENT and is never
silently re-resolved to a different element — that rule
already exists in `resolve()` and must stay.

### 3.3 Pruning and deltas (so the merged tree stays cheap)

- Default view: interactive + headings + landmarks only,
  but "interactive" now means the heuristic above, not
  the old narrow role list. That alone would have
  surfaced Instagram's Create menu.
- `snapshot --delta`: return only nodes added, removed,
  or changed since the last snapshot on that tab, with
  stable refs. This is the agent-browser pattern and
  it is what makes re-observing after every click cheap
  instead of re-reading the whole feed.
- `observe` output caps stay, but dialog/modal content
  is returned first, before feed/body text, so a
  "Crop / Next" or "Post shared" state is not buried
  at the end of a long page.

### 3.4 Find and click, rewritten on the merged tree

- `page.find` and `dom.find` search role, name, text,
  tag, and selector across the merged tree, not just
  a11y labels. `find("Post", by: "text")` must find
  the Instagram menu row.
- `act` click resolution order, explicit and fixed:
  1. exact `ref`; 2. role + name; 3. text (exact, then
  contains, with ambiguity reported, never silently
  picking the first of several); 4. selector;
  5. coordinates, last resort only.
  A click that lands on a different element than the
  one resolved must be reported as a mismatch, not
  as `clicked: true`.
- Coordinates, when they are used: accept normalized
  0–1000 coordinates directly in `dom.clickAt` /
  `act`, and always return screenshot width/height
  alongside any screenshot. The 633-vs-689 bug
  becomes impossible by construction.
- Screenshots become annotated: numbered markers
  drawn over the merged nodes that have a bbox but
  no name/role, so a vision fallback still clicks a
  real node, not a guessed pixel.

## 4. Instructions: stop stopping, stop assuming

This is a code change to the instructions every Muze
client receives, not a suggestion in a chat message.
It goes into `MCP_INSTRUCTIONS` in `cloudflare/src/mcp.ts`
(hand-written section, next to the existing CORE AGENTIC
LOOP), and the generated tool-selection section in
`extension/libs/tool-contracts/instructions.ts` is
left alone. Clients that ignore MCP instructions still
get the task-runner enforcement in section 5.

New section, in substance (exact wording to be
finalised in the code change):

**EXECUTION DISCIPLINE — read before any multi-step task**

1. **Finish the task or report it as unfinished. Never
   stop in the middle and call it done.** A first
   failure, a missing element, a timeout, or a
   tool that returns an error is a signal to try
   the next grounding method, not a reason to
   stop. Report `partial` only when you have
   actually stopped, and say exactly which steps
   are done and which are not.
2. **Never assume an identity.** A file is identified
   by id + name + size, a tab by id + URL, an
   element by ref + role + name + bounding box.
   If two candidates match, re-observe and
   disambiguate; do not pick the similar one.
   (Live lesson: "Post" vs "Live video" are
   adjacent menu rows. Picking the similar one
   opened the wrong dialog.)
3. **Never claim success from a click.** `clicked:
   true` means the click was dispatched, not that
   the intended effect happened. Success is only
   a post-action observe showing the expected
   state: the dialog title, the button label,
   "Post shared", a profile post count, or a
   post URL. Until that observe, the step is
   unproven.
4. **Fallback ladder, in this order, per step:**
   a. re-observe (fresh snapshot, delta first);
   b. find by role + name, then by text, then
   by selector;
   c. merged snapshot with heuristic clickable
   nodes;
   d. annotated screenshot + normalized
   coordinates;
   e. ask the user, but only after a–d have
   actually been tried, and say which ones
   were tried and what each returned.
   Do not jump to (e) on the first failure, and
   do not jump to (d) before (a)–(c).
5. **Stale is stale.** If a ref is stale, re-observe
   and mint a fresh ref for the same element.
   Never re-resolve a stale ref to a different
   element that happens to match now.
6. **Do not invent a file, a post, or a result.**
   If a file is not in the Muze file store and
   no bytes were supplied, say so and stop that
   branch — but keep the rest of the task's
   verifiable work going, and say what would
   unblock it (attach the file here, or in the
   Muze dashboard Files page).
7. **Approvals are not a fallback to skip.**
   A consequential step (submit, share, delete,
   clipboard write) still waits for a real
   approval. The fallback ladder never bypasses
   approval, and a confirmation flag in tool
   input is stripped and never counts.

These rules apply to ChatGPT, Claude, and Panda
equally, because they are in the MCP instructions
the gateway sends to every client, not in any
one client's system prompt.

## 5. Enforcement in the task runner (instructions alone are not enough)

Instructions change behaviour only if the client
reads them. The durable version is a task-runner
change, using the task engine Muze already built
(`tasks.create`, `tasks.get`, checkpoints, plan
bounds, partial-on-denial):

- A multi-step flow (Instagram post is the
  reference case: Create → Post → setFile →
  Next → Next → Share → verify) is run as one
  `tasks.create` plan, not as 30 separate agent
  turns. The runner checkpoints after every step,
  so a client turn break resumes from the last
  checkpoint instead of restarting — restarting
  is how duplicate posts happen.
- Per step, the runner itself walks the fallback
  ladder: if a ref click fails, it re-observes
  and retries by text, then by selector, then
  by annotated coordinates, up to the plan's
  `maxAttemptsPerStep`, before marking that
  step failed. The agent does not have to
  remember to do this; the runner does it and
  reports which method finally worked.
- Verification is a step, not an afterthought:
  every consequential step is followed by a
  verify step (observe for the expected state)
  that must pass before the task is `done`.
  A task with a failed verify step is `partial`,
  never `done`.
- Plan bounds stay: allowed tools, allowed
  domains, max steps, and allowExternalSubmit
  are set at plan approval. A fallback never
  expands the bounds.

## 6. Plan, in order

**Phase 0 — Baseline (no code).**
Replay the Instagram Create menu on the live
tab and record: nodes returned by the current
snapshot, which Create-menu items are missing,
failed label clicks, screenshots taken, wrong-
element clicks. This is the number every later
phase must beat.

**Phase 1 — Instructions only (gateway).**
Add the EXECUTION DISCIPLINE section to
`MCP_INSTRUCTIONS` in `cloudflare/src/mcp.ts`.
Deploy with `npm run deploy` (build, never
bare `wrangler deploy`). Re-run the same
Instagram task in ChatGPT and in Panda and
measure: did the agent stop early, did it
try the ladder, did it claim success without
a verify observe? Expected gain: fewer early
stops, no speed gain by itself.

**Phase 2 — Merged snapshot (extension).**
Implement section 3 in
`extension/libs/browser-engine/page/agent.ts`:
heuristic clickable layer first (no CDP risk),
then CDP AX with fallback and an explicit
`ax: unavailable` signal. Change
`interactiveOnly` to use the heuristic set.
Add delta snapshots and dialog-first ordering
in `observe`. Extension tests, both builds,
contracts in sync, then user pull +
rebuild + reload. Expected gain: Create,
Post, Next, Share all clickable by ref or
text on first try, zero screenshots for a
standard post flow.

**Phase 3 — Find, click, coordinates (extension).**
Rewrite `page.find` / `dom.find` on the merged
tree, fix `act` resolution order, add
normalized 0–1000 coordinates to
`dom.clickAt` / `act`, and annotated
screenshots. Same deploy/reload flow as
Phase 2. Expected gain: the 633-vs-689
class of bug disappears; screenshot becomes
a genuine last resort.

**Phase 4 — Task-runner fallback + verify steps.**
Implement section 5 in the existing task
engine: per-step ladder, checkpoint resume,
mandatory verify step after consequential
steps. Test with a deliberately broken first
method (e.g. a stale ref) and prove the
runner recovers without agent intervention
and without duplicating the action.

**Phase 5 — Regression and proof.**
Full extension + Cloudflare suites pass.
Live proof, same as the original task, with
a test post the user deletes after:
Instagram post with zero screenshots, zero
wrong-element clicks, and a verified post
URL. Also re-run a read flow (Facebook
observe) and an acting flow on a public
page (Wikipedia) to prove no regression.
Only then consider a version bump (0.5.1
was already deferred until live proof
accumulates).

## 7. Risks and what this plan deliberately does NOT do

- CDP AX attachment may be flagged by Meta
  on Instagram. Mitigation: try AX, fall
  back to DOM + heuristic, label the source,
  never claim AX when it was not used.
- A merged tree can get large. Mitigation:
  interactive + headings + landmarks by
  default, delta snapshots, bounded text.
- Instructions do not override a client's
  own turn limits. Mitigation: the task
  runner (Phase 4) is the durable fix;
  instructions (Phase 1) are the fast one.
- No approval bypass, no auto-approve, no
  removal of the stale-ref rule, no guessing
  a file's identity, no screenshot-first
  design. Those are guardrails, not speed
  optimisations to trade away.

## 8. Tools audited for this plan

- `observe` (metadata, text, a11y, ast, forms,
  links, screenshot) — needs merged snapshot,
  delta, dialog-first ordering.
- `page.snapshot`, `page.accessibilityTree` —
  same merged tree, not a separate tree.
- `page.find`, `dom.find` — search merged
  tree by role, name, text, selector.
- `act`, `dom.click`, `dom.clickAt` — fixed
  resolution order, normalized coordinates,
  mismatch reporting.
- `form`, `forms.setFile` — already works
  with stored fileId and inline bytes; no
  change needed for this plan, except that
  a setFile success must still be followed
  by a verify observe.
- `screenshots.visible` — annotated, last
  resort only.
- `tools.batch` — read-only batching, keep
  using it for independent reads.
- `tasks.create`, `tasks.get`, `tasks.list`,
  `tasks.pause`, `tasks.resume`, `tasks.cancel`,
  `tasks.approvePlan` — the persistence and
  fallback-runner vehicle in Phase 4.
- `tools.discover` — no change; discovery
  already returns the full registry.

## 9. Phase 6 — Dynamic per-task prompts (smallest version, built 2026-10-28)

Status: BUILT IN CODE ONLY — no push, no deploy, no live test.
Version stays 0.5.0, no registry bump, no inventory regeneration.

### 9.1 Why not a giant system prompt

A single static prompt sent at initialize burns context on
tools the task will never use, gets ignored in the middle,
and cannot know whether this task is a 1-click read or a
6-screen post. Phase 6 splits the prompt into layers:

- **Static core, at initialize only.** The shrunken
  `MCP_INSTRUCTIONS` in `cloudflare/src/mcp.ts` now
  carries only: the Observe → Reason → Act → Verify
  loop, a short EXECUTION DISCIPLINE section, the
  unchanged approval rules, and a pointer saying
  per-task detail comes from MCP prompts and
  `tools.discover`. The detailed master-tools bullet
  lists were removed; tool names and schemas are
  already available via ListTools, discovery, and
  the generated tool-selection section appended
  after the core text.
- **Per-task prompt, via MCP `GetPrompt`.** The client
  fetches the prompt for the task at hand, with its
  arguments filled in, instead of receiving every
  use case every time. The first per-use-case
  prompt is `post_image_to_instagram` (see 9.4).
- **Tool metadata, via `tools.discover`.** Discovery
  already scores by exact name, tag, category,
  verb, and description, and returns full schemas
  for only the top 5 results. Phase 6 uses that
  as the selection rule: full schema only for
  plan-needed tools, names only for related tools,
  nothing for the rest.

### 9.2 Plan vs direct — the decision table

Go direct, with no plan, only when ALL of these hold:

- 1–3 steps, all reversible or read-only;
- the element and the file are already grounded,
  with no ambiguity;
- no consequential step (no post, submit, delete,
  or payment);
- no approval needed mid-task, or approval has
  already been given for this exact action.

A plan is required when ANY of these hold:

- more than 3 steps, or steps that depend on
  each other (Create → Post → upload → Next →
  Next → Share is the reference case);
- any post, submit, delete, or payment step;
- ambiguity: two similar elements, an unconfirmed
  file identity, a new site, or a new dialog;
- approval will be needed mid-task;
- a prior attempt has already failed.

A plan, in Muze terms, is a real object, not
just text: `tasks.create` with steps, bounds,
and a verify step after each consequential
step. `tasks.create` with `dryRun: true` gives
a preview before anything runs.

### 9.3 Escalation: direct to plan, automatically

A task may start direct and must escalate to a
plan when reality disagrees with the first
classification. Escalate on any of:

- 2 failures on the same step;
- a new dialog appearing that was not in the
  original goal;
- ambiguous candidates (two elements or files
  matching the same description);
- a consequential step appearing that was not
  planned.

Escalation means: stop improvising single calls,
build the plan object, get plan approval where
required, and resume from the last checkpoint —
never restart from scratch, because restarting
is how duplicate posts happen. The fallback
ladder from Phase 1 (re-observe → ref →
role + name → text → selector → screenshot
coordinates last) still applies inside the plan.

### 9.4 The first per-use-case prompt: post_image_to_instagram

Arguments: `fileName` (required), `fileId`
(optional, Muze file-store id), `caption`
(optional), `tabId` (optional).

The prompt is a complete task prompt for
posting that exact image to Instagram via
Muze, including: verify file identity by
id + name + size and never assume
banner-image.png is another image; this is
a plan-required task (>3 steps, consequential
Share); steps in order — observe the
Instagram tab, open Create then Post (by
ref, then role + name, then text, then
selector, screenshot coordinates only as a
last resort), form inspect, set the file by
stored fileId or inline bytes, Crop → Next,
Edit → Next, Share, then verify with an
observe showing "Post shared" and the profile
post URL; do not delete the post (the user
deletes test posts); do not claim success
from a click alone; if a step fails, walk
the fallback ladder and re-observe instead
of stopping.

### 9.5 What Phase 6 deliberately does NOT do

- It does not hide safety or approval text:
  the core layer keeps the approval rules
  verbatim, and a confirmation flag is still
  stripped and never counts.
- It does not change scope, OAuth, bridge,
  or tool execution logic.
- It does not remove the stale-ref rule or
  the no-assume rule; those are in the core
  layer for every task.
- It does not prove anything live: the new
  prompt and the shrunken instructions still
  need a live run (a test post, deleted by
  the user after) before any version bump.
