# Muze AI — 10-minute live test plan (Claude and ChatGPT web via MCP relay)

Version under test: Muze AI 0.3.0, in ~/workspace/muze-ai/
Status before this plan: unit and gateway tests pass in mock/Miniflare only.
No live proof yet with a real Claude or ChatGPT web client, a real browser,
or a real extension. This plan is how we get that proof, and how we find
out exactly where a 10-minute workflow breaks, if it does.

## 0. What "pass" means

A 10-minute workflow passes only if ALL of these are true:

- The same MCP session id is used from first call to last call, unless
  the client deliberately starts a new session and that is recorded.
- Every step finishes, or fails with a clear, recorded error that the
  client can recover from. No silent stop, no silent restart from scratch.
- No single tool call takes over 30 seconds in the extension executor,
  or over 60 seconds on the bridge. Those are the code limits in 0.3.0.
- No approval expires unnoticed. Every approval is approved, denied, or
  recorded as expired, with its time.
- The extension dashboard Activity log matches what the client saw:
  same tools, same order, same decisions.
- The browser ends in the expected state, with no extra tabs, clicks,
  submits, or downloads that the task did not ask for.

If any of these fails, the test fails, even if the final answer looks
right. Record the failure type, not just "it did not work".

## 1. Setup — do this once, before any test

Estimated time: 30 to 45 minutes, first time only.

1. Build from the fixed copy, do not use the old 0.2.0 zip:
   - `npm run install:all`
   - `npm run sync:contracts && npm run check:contracts`
   - `npm run build`
   - `npm run package:extension` if you want a zip, otherwise load
     `extension/dist/` unpacked.
2. Deploy the gateway from the same copy:
   - `npm --prefix cloudflare run deploy`
   - Deploy builds first, because wrangler points at `dist/index.js`.
   - Set `EXTENSION_IDS` to your extension id in production. Without it,
     extension sign-in is disabled.
3. Use a test Chrome profile, not your main profile:
   - No real passwords, no real payment pages, no real purchases.
   - Load the extension unpacked, open its dashboard, sign in.
   - Set permission level to Balanced (the default). Do not use
     Unrestricted for these tests, because then approvals are skipped
     and the approval test proves nothing.
   - Confirm dashboard shows: gateway Live, signed in, token masked
     (last 4 characters only).
4. Connect one client at a time. Test Claude first, then ChatGPT web,
   with the same task and the same test pages, so results are comparable.
   - Claude: add the gateway MCP URL as a remote MCP server, OAuth
     flow, S256 PKCE, `response_type=code` required.
   - ChatGPT web: paid plan, web only, Settings -> Apps -> Advanced
     settings -> Developer mode ON -> Create app, same gateway MCP URL,
     Authentication: OAuth (not No authentication, not a pasted key).
5. Prepare test pages in advance, all public and harmless:
   - 5 to 10 simple article or documentation pages, for reading.
   - 1 test form page you control, with no real submit destination,
     for the approval test only.
   - No login pages, no bank, email, or shopping pages.
6. Prepare a recording sheet before you start. For every tool call,
   record: time, tool name, how long it took, session id if visible,
   approval yes/no and how long it took, and any error text exactly
   as shown. Take a screenshot of the dashboard Activity log at the end
   of each test. Never paste a full token, password, or full tool input
   into the recording sheet.

Safety during all tests:
- Kill switch in the dashboard stops every tool call at once. Use it
  if the client does anything unexpected.
- Dashboard sign-out and token rotate are available if a token is
  exposed in a screenshot. Rotate after the tests if you shared any
  screen.

## 2. Test A — 10-minute read-only workflow, Claude

Goal: prove a multi-call MCP workflow can span 10 minutes with no
approvals in the way.

Task to give Claude, in one prompt:
"Using Muze AI, read these 10 pages in order, and after each page tell
me its title and one sentence summary. Do not click any link that
leaves the page list, do not fill any form, do not download anything.
At the end, list all 10 titles in order."

What to watch:
- Start time, end time, total wall-clock time. Aim for about 10 minutes
  by choosing pages that take time to load and read, not by adding
  artificial waits.
- Number of tool calls, and time per call. Flag any call over 20 seconds
  as a warning, over 30 seconds as a failure for that call.
- Session id: if Claude shows it, check it does not change mid-task.
  If it does change, record when and what happened next.
- Dashboard Activity: does it show the same 10 reads, in the same order?

Pass: all 10 pages read, titles in order, no timeout, no disconnect,
no extra action.
Fail: client stops early, says it cannot continue, loses the list,
repeats pages from scratch, or the dashboard shows a different order.

## 3. Test B — 10-minute read-only workflow, ChatGPT web

Same task, same pages, same order, same permission level, in ChatGPT web.

What to watch, in addition to Test A:
- Does ChatGPT web keep the same MCP session for the whole task, or
  does it start a new session part way through?
- Does it stop after a certain number of tool calls in one turn and
  ask you to say "continue"? If so, record the exact call count where
  it stopped. That is a client turn limit, not a Muze failure, but it
  changes what "10 minutes" means in practice.
- Does it handle the tool list the same way? Core tools only by default,
  other tools through discover, unless show-all is set.

Pass and fail are the same as Test A, plus: if ChatGPT asks you to
continue, the test is not a clean pass. It is a "pass with manual
continue" and must be recorded that way.

## 4. Test C — Approval workflow, both clients separately

Goal: prove a consequential step does not silently stall or silently
approve a 10-minute task.

Task to give the client, on your test form page only:
"Fill this test form with the test values I give you, show me a preview
first, and only submit after I approve in chat or in the dashboard."

What to watch:
- Time from approval request to your decision, and whether the client
  used elicitation in chat, or only the dashboard.
- If the client does not support elicitation, the gateway falls back
  to a 120 second dashboard wait, then returns approval required.
  Record which path each client actually took.
- What happens if you wait over 120 seconds on purpose for one step?
  Expected: approval expires, the step fails cleanly, and the client
  asks again. It must not submit anyway, and must not claim approval
  it did not get.
- What happens if you deny one step? Expected: that step stops, earlier
  steps stay done, and the client reports the denial honestly.

Pass: preview shown, no submit before approval, expiry and denial
both handled cleanly.
Fail: submit without approval, approval claimed without a decision,
or the whole task restarts from scratch after a denial or expiry.

## 5. Test D — Idle gap and resume, both clients separately

Goal: prove a session can survive a gap, and prove what happens when
it cannot.

Steps:
1. Start a short read task, do 3 pages, then stop sending anything
   for 6 minutes. Do not close the browser or the client.
   - 6 minutes is chosen because the Session Durable Object warm
     window is 5 minutes. This tests cold restart and replay of
     initialize from the saved session.
2. After 6 minutes, ask the client to continue with page 4.
3. Record: same session id or new session id, does the client remember
   pages 1 to 3 from its own conversation, does the extension dashboard
   show a reconnect, does the bridge reconnect without a new sign-in?

Pass: continues from page 4, no duplicate work, no new sign-in needed.
Fail with a clear type: session lost, bridge lost, client forgot the
list, or the task restarts from page 1.

Note: a pass here still does not prove a saved task object exists.
There is none in 0.3.0. A pass means the client remembered, not that
the extension remembered. Record that distinction.

## 6. Test E — Disconnect and reconnect, extension only

Goal: prove the failure mode is clear, not silent.

Steps:
1. Start a read task.
2. Mid-task, turn the bridge off in the dashboard, or close the
   browser window with the extension, for 30 seconds, then turn it
   back on / reopen it.
3. Ask the client to continue.

Expected in 0.3.0: gateway reports no browser connected, the client
must wait or retry, and after reconnect it can continue only if the
client remembers where it was.
Fail: client claims success while the browser was offline, or it
repeats already-done consequential steps without checking.

## 7. Test F — Slow step, deliberate, both clients separately

Goal: prove the 30 second executor limit behaves as documented,
instead of hanging for 10 minutes.

Steps:
1. Ask the client to wait for a deliberately slow test page, or to
   use a sync wait over 30 seconds, on a harmless page.
2. Record the exact error, the time it took, and what the client does
   next: retry, split the wait, or give up.

Expected: a timeout error at about 30 seconds for the extension call,
or 60 seconds at the bridge at most, with a clear error code, not a
hang. This test is expected to fail that one call. It passes as a
test if the failure is clean and recoverable.

Do not run this test on a real form, purchase, or download.

## 8. What to record, for every test

Copy this table for each test and fill it in during the test, not
afterwards from memory:

- Test name and client: A/B/C/D/E/F, Claude or ChatGPT web
- Start time, end time, total minutes
- Session id at start, session id at end, changed yes/no and when
- Tool calls total, calls over 20 seconds, calls over 30 seconds
- Approvals total, approved, denied, expired, longest approval wait
- Disconnects total, reconnect time, bridge status in dashboard
- Final result: pass, pass with manual continue, or fail
- Failure type, in one line: timeout, session lost, approval expired,
  bridge lost, client turn limit, page changed, other
- Dashboard Activity screenshot filename, and whether it matches
  the client log

## 9. If a test fails, diagnose in this order

1. Timeout on one call: check the call time. Over 30 seconds means
   executor limit. Over 60 seconds means bridge limit. Under both
   means the client timed out on its own side. Record which one.
2. Session lost: check if the client sent a new session id, if the
   Session Durable Object evicted, and if the extension bridge was
   still connected in the dashboard at that time.
3. Approval stalled: check if the client supports elicitation. If
   not, the dashboard is the only path, and 120 seconds is the limit.
   Check the dashboard Activity log for the approval record.
4. Bridge lost: check dashboard gateway status, extension sign-in
   state, and whether the browser was closed, suspended, or lost
   network. Check the bridge auth close code if shown: missing or
   late auth versus invalid auth are different failures.
5. Client stopped early: check the call count at the stop. That points
   to a client turn limit, not a Muze timeout, if calls were fast
   and no error was shown.
6. Wrong result: check dashboard order versus client order, and check
   for stale refs, page changes, or repeated steps. Do not rerun the
   same test until the first failure is recorded, or you will lose
   the evidence.

## 10. Decision after the tests

- If Tests A and B pass cleanly on both clients: 10-minute multi-call
  MCP workflows are proven for read-only work. Move on to approval
  and resume work only if Tests C and D also pass.
- If Tests A or B pass only with manual continue: the workflow works,
  but the client turn limit is the real 10-minute limit. The fix is
  either shorter tasks per prompt, or a task object in the extension
  that survives a client turn break.
- If Tests C or D fail: do not claim 10-minute workflows work for
  consequential or long-gap tasks. The next build is plan-level
  approval and a persistent task object with checkpoints, not more
  timeout tuning.
- If Test E or F shows a silent failure: fix that failure mode first.
  A silent success while offline, or a silent repeat of a done step,
  is worse than a clean timeout.

## 11. Estimated time

- Setup first time: 30 to 45 minutes
- Test A: about 15 minutes including recording
- Test B: about 15 minutes including recording
- Test C, both clients: about 30 minutes including deliberate expiry
- Test D, both clients: about 30 minutes including the 6-minute gaps
- Test E: about 10 minutes
- Test F, both clients: about 20 minutes
- Total: about 2 to 2.5 hours, not counting fixes for failures found.

These are estimates for planning, not a promise. A failure in an
early test can stop later tests until it is diagnosed.
