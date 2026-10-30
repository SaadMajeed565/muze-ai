import { useEffect, useState } from "preact/hooks";
import type { ApprovalRequestInfo, ClientIdentity } from "../../libs/tool-contracts/index.js";
import type { AuditEvent } from "../../libs/security/index.js";
import { formatCountdown, formatRelativeTime } from "../logic.js";
import { plainActivityKind, plainDecision, truncateText } from "../ui-logic.js";
import { Button, EmptyState } from "../components/primitives.js";
import { ListRow, Page, Section, SectionSkeleton } from "../components/layout.js";

export interface ActivityPageProps {
  approvals: ApprovalRequestInfo[];
  audit: AuditEvent[] | null;
  auditLoading: boolean;
  busy: boolean;
  onRespond: (approvalId: string, approved: boolean) => void;
  onCancelForClient: (clientId: string) => void;
  onRefreshAudit: () => void;
}

function decisionTone(decision: string): "ok" | "bad" | "warn" | "neutral" {
  if (decision === "denied" || decision === "error") return "bad";
  if (decision === "approval-required" || decision === "preflight-unavailable") return "warn";
  if (decision === "allowed") return "ok";
  return "neutral";
}

function pendingByClient(approvals: ApprovalRequestInfo[]): Map<string, { client: ClientIdentity; approvals: ApprovalRequestInfo[] }> {
  const groups = new Map<string, { client: ClientIdentity; approvals: ApprovalRequestInfo[] }>();
  for (const approval of approvals) {
    const existing = groups.get(approval.client.id);
    if (existing) existing.approvals.push(approval);
    else groups.set(approval.client.id, { client: approval.client, approvals: [approval] });
  }
  return groups;
}

/**
 * Activity as one timeline: requests waiting for the user first, then
 * recent activity in plain sentences. The old approvals banner is
 * gone — approvals live here, not over every page. No tool names, no
 * risk labels, no audit records are ever rendered: an audit event
 * becomes "what happened, who asked, when, and what the outcome was".
 */
export function ActivityPage({
  approvals,
  audit,
  auditLoading,
  busy,
  onRespond,
  onCancelForClient,
  onRefreshAudit,
}: ActivityPageProps): preact.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const groups = pendingByClient(approvals);
  const multiClient = [...groups.values()].filter((group) => group.approvals.length > 1);

  const cancelForClient = (client: ClientIdentity, count: number): void => {
    const ok = confirm(`Cancel all ${count} pending request${count === 1 ? "" : "s"} from ${client.name}? The waiting actions will be denied.`);
    if (ok) onCancelForClient(client.id);
  };

  return (
    <Page title="Activity" subtitle="Requests waiting for you, and what happened recently.">
      <Section
        title="Waiting for you"
        description={
          approvals.length > 0
            ? `${approvals.length} request${approvals.length === 1 ? "" : "s"} pending. Each expires after two minutes.`
            : "Requests appear here when an action needs your approval."
        }
      >
        {approvals.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing waiting"
            description="Actions that need your approval will pause here until you approve or deny them."
          />
        ) : (
          <ul class="ui-list">
            {approvals.map((approval) => (
              <ListRow
                key={approval.id}
                title={approval.title}
                meta={`${truncateText(approval.summary, 160)} · ${approval.client.name} · ${formatCountdown(approval.expiresAt, now)}`}
                status="Waiting for you"
                statusTone="warn"
                actions={
                  <>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRespond(approval.id, false)}>
                      Deny
                    </Button>
                    <Button variant="primary" size="sm" icon="check" disabled={busy} onClick={() => onRespond(approval.id, true)}>
                      Approve
                    </Button>
                  </>
                }
              />
            ))}
          </ul>
        )}

        {multiClient.length > 0 ? (
          <div class="ui-chip-row">
            {multiClient.map((group) => (
              <Button key={group.client.id} variant="ghost" size="sm" disabled={busy} onClick={() => cancelForClient(group.client, group.approvals.length)}>
                Cancel {group.approvals.length} from {group.client.name}
              </Button>
            ))}
          </div>
        ) : null}
      </Section>

      <Section
        title="Recent activity"
        description="The last 50 recorded events, newest first, in plain words."
        action={
          <Button variant="ghost" size="sm" icon="refresh" disabled={auditLoading} onClick={onRefreshAudit}>
            Refresh
          </Button>
        }
      >
        {auditLoading && !audit ? (
          <SectionSkeleton />
        ) : !audit || audit.length === 0 ? (
          <EmptyState
            icon="pulse"
            title="No activity yet"
            description="Actions, permission changes and approvals will be recorded here as they happen."
          />
        ) : (
          <ul class="ui-list">
            {audit.map((event) => (
              <ListRow
                key={event.id}
                title={plainActivityKind(event.kind)}
                meta={`${event.client ? event.client.name + " · " : ""}${formatRelativeTime(Date.parse(event.at), now)}`}
                status={plainDecision(event.decision)}
                statusTone={decisionTone(event.decision)}
              />
            ))}
          </ul>
        )}
      </Section>
    </Page>
  );
}
