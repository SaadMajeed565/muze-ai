# Phase D — Durable audit: scoped evaluation (NOTE ONLY, not a build)

Status: evaluation only. Nothing in this note is implemented in Phase D.
No audit record is persisted by Phase D, no approval/scope/policy rule
changed, no new storage key added. This note exists because Phase D of
the OpenCode adoption plan (§6) asks for the evaluation, and explicitly
does not promise the build.

## What exists today (verified from code)

- Extension audit is in-memory only, capped at 1000 events in the service
  worker (`extension/libs/security/audit.ts` via `AuditLog`). Every record
  goes through `redact()`: size/truncation metadata only, never tokens,
  secrets, cookies, or tool inputs/outputs. It does not survive a
  service-worker restart.
- Task audit entries are different: the runner persists a per-step audit
  entry (task id, step index, tool, decision, outcome — never inputs or
  secrets) as part of its checkpoint ordering (persist → audit → progress),
  and the gateway keeps a status-only task mirror (`mcp:tasks`, max 100
  entries: id, status, step progress, browser session, timestamp).
- The dashboard Activity page reads the in-memory audit while the worker
  is alive; after a restart, history is gone. That ephemerality is a
  privacy feature as well as a limitation (plan §8: audit/privacy).

## What durable audit beyond the dashboard events would require

Two candidate stores, neither chosen here:

1. **`chrome.storage.local` with the same redaction and a bound.**
   Requires: a new storage key with a hard event cap and age/size prune
   (mirroring the 1000-event in-memory cap, not unbounded growth);
   re-verification that `redact()` runs before every write, including
   for the runner-mapped `tool.call` entries the service worker records;
   a migration story for the existing in-memory log (drop on restart is
   today's behaviour — persisting only from the switch-over point avoids
   inventing history); and dashboard pagination, since Activity today
   assumes a small in-memory list.
2. **A gateway Durable Object with status-only records.**
   Requires: a new DO (or an extension of SessionDO storage) holding
   only status/progress-shaped records — the task-mirror rule applied to
   audit; a redaction pass at the gateway boundary, since the gateway
   must never receive inputs, outputs, or page content to persist;
   per-account isolation via the existing DirectoryDO session mapping
   (one account = one browser session); and a retention bound with
   eviction, or the DO grows without limit. This also widens the
   data-at-rest surface to Cloudflare's infrastructure, which is a
   strictly larger trust decision than local extension storage.

In both cases, the following must hold before any build: redaction
re-verified by test (a record carrying a token/secret-shaped value must
never reach storage); a bound proven by test (storage stops growing past
the cap); and the dashboard never rendering raw step inputs, page
content, or screenshots from the new store (the existing sanitiser
allowlist in `task-dashboard.ts` is the pattern to extend, not bypass).

## What is blocked on a user decision

- Whether audit history surviving a service-worker restart is wanted at
  all, given that ephemerality is currently a privacy feature. If the
  user values "restart wipes history", durable audit must not be built.
- If it is wanted: local-only (`chrome.storage.local`) vs gateway DO.
  Local keeps data on the user's machine; gateway makes history
  available across clients but moves it off-device. That choice, plus
  the retention bound (event count and/or age), must come from the user
  before any implementation starts.
- Whether the bound should match today's 1000 events or be larger, and
  whether task audit entries (already checkpointed) should be the first
  durable slice rather than the full in-memory log.

## Deliberately NOT built in this phase

- No durable audit store, no new storage key, no gateway DO change.
- No change to what audit records contain: still redacted metadata
  only, never content.
- No file-store encryption (plan's Phase D exclusion, separate concern).
- No backfill or migration of past in-memory audit events.
- No dashboard history UI beyond what exists today.

## Next step if the user approves later

Pick store (local first, as the smaller trust change), bound, and
retention; then implement behind tests for redaction, the bound, and
the sanitiser allowlist — and only then decide a version bump, per the
plan's rule that version changes follow live proof, not code time.
