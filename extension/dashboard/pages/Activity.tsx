import { useEffect, useState } from "preact/hooks";
import type { ApprovalRequestInfo, ClientIdentity } from "../../libs/tool-contracts/index.js";
import type { AuditEvent } from "../../libs/security/index.js";
import type { IconName } from "../logic.js";
import { formatCountdown, formatRelativeTime } from "../logic.js";
import { Icon } from "../components/Icon.js";
import { Badge, Button, Card, EmptyState, Skeleton } from "../components/primitives.js";

export interface ActivityPageProps {
  approvals: ApprovalRequestInfo[];
  audit: AuditEvent[] | null;
  auditLoading: boolean;
  busy: boolean;
  onRespond: (approvalId: string, approved: boolean) => void;
  onCancelForClient: (clientId: string) => void;
  onRefreshAudit: () => void;
}

const KIND_LABEL: Record<AuditEvent["kind"], string> = {
  "tool.call": "Tool call",
  "tool.result": "Tool result",
  "policy.change": "Policy change",
  "client.connect": "Client connected",
  "client.disconnect": "Client disconnected",
  approval: "Approval",
  "kill-switch": "Emergency stop",
  "token.rotate": "Token rotated",
};

const KIND_ICON: Record<AuditEvent["kind"], IconName> = {
  "tool.call": "arrow-right",
  "tool.result": "check",
  "policy.change": "sliders",
  "client.connect": "link",
  "client.disconnect": "close",
  approval: "alert",
  "kill-switch": "power",
  "token.rotate": "refresh",
};

function decisionTone(decision: AuditEvent["decision"]): "success" | "danger" | "warning" {
  if (decision === "denied" || decision === "error") return "danger";
  if (decision === "approval-required" || decision === "preflight-unavailable") return "warning";
  return "success";
}

/**
 * Group pending approvals by client id, not by client object reference.
 * Grouping by reference silently split one client into several groups
 * whenever the dashboard rebuilt the client object between polls (the old
 * bug); the id is stable across polls. The first-seen client object is kept
 * for display.
 */
function pendingByClient(approvals: ApprovalRequestInfo[]): Map<string, { client: ClientIdentity; approvals: ApprovalRequestInfo[] }> {
  const groups = new Map<string, { client: ClientIdentity; approvals: ApprovalRequestInfo[] }>();
  for (const approval of approvals) {
    const existing = groups.get(approval.client.id);
    if (existing) existing.approvals.push(approval);
    else groups.set(approval.client.id, { client: approval.client, approvals: [approval] });
  }
  return groups;
}

export function ActivityPage({
  approvals,
  audit,
  auditLoading,
  busy,
  onRespond,
  onCancelForClient,
  onRefreshAudit,
}: ActivityPageProps): preact.JSX.Element {
  // Countdowns tick on their own 1s timer, not only on the 5s poll.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const groups = pendingByClient(approvals);
  const multiClient = [...groups.values()].filter((group) => group.approvals.length > 1);

  /** Cancelling a client's approvals is destructive (pending calls fail), so confirm first. */
  const cancelForClient = (client: ClientIdentity, count: number): void => {
    const ok = confirm(`Cancel all ${count} pending approval${count === 1 ? "" : "s"} from ${client.name}? The waiting tool calls will be denied.`);
    if (ok) onCancelForClient(client.id);
  };

  return (
    <div class="stack">
      <Card
        title="Waiting for you"
        icon="alert"
        description={
          approvals.length > 0
            ? `${approvals.length} request${approvals.length === 1 ? "" : "s"} pending. Each expires after two minutes.`
            : "Requests appear here when the level requires an approval."
        }
        actions={
          approvals.length > 0 ? (
            <span class={"pill pill--warn"}>{approvals.length} pending</span>
          ) : (
            <span class="pill">None</span>
          )
        }
      >
        {approvals.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing waiting"
            description="Risky tool calls will pause here until you approve or deny them."
          />
        ) : (
          <div class="approval-list">
            {approvals.map((approval) => (
              <article class="approval-card" key={approval.id}>
                <header class="approval-card-head">
                  <span class="approval-card-title">{approval.title}</span>
                  <span class={"badge risk risk--" + (approval.risk === "consequential" || approval.risk === "restricted" ? "danger" : "warning")}>
                    {approval.risk}
                  </span>
                </header>
                <p class="approval-card-summary">{approval.summary}</p>
                <p class="approval-card-meta">
                  <Icon name="user" size={13} />
                  <span>{approval.client.name}</span>
                  <code>{approval.tool}</code>
                  <span class="approval-countdown">{formatCountdown(approval.expiresAt, now)}</span>
                </p>
                <div class="approval-card-actions">
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => onRespond(approval.id, false)}>
                    Deny
                  </Button>
                  <Button variant="primary" size="sm" icon="check" disabled={busy} onClick={() => onRespond(approval.id, true)}>
                    Approve
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}

        {multiClient.length > 0 ? (
          <div class="chip-row">
            {multiClient.map((group) => (
              <Button key={group.client.id} variant="ghost" size="sm" disabled={busy} onClick={() => cancelForClient(group.client, group.approvals.length)}>
                Cancel {group.approvals.length} from {group.client.name}
              </Button>
            ))}
          </div>
        ) : null}
      </Card>

      <Card
        title="Activity log"
        icon="pulse"
        description="The last 50 recorded events, newest first."
        actions={
          <Button variant="ghost" size="sm" icon="refresh" disabled={auditLoading} onClick={onRefreshAudit}>
            Refresh
          </Button>
        }
      >
        {auditLoading && !audit ? (
          <div class="skeleton-list">
            <Skeleton width="85%" />
            <Skeleton width="70%" />
            <Skeleton width="92%" />
            <Skeleton width="60%" />
          </div>
        ) : !audit || audit.length === 0 ? (
          <EmptyState
            icon="pulse"
            title="No activity yet"
            description="Tool calls, policy changes and approvals are recorded here as they happen."
          />
        ) : (
          <ul class="audit-list">
            {audit.map((event) => (
              <li class="audit-row" key={event.id}>
                <span class="audit-icon" aria-hidden="true">
                  <Icon name={KIND_ICON[event.kind]} size={14} />
                </span>
                <div class="audit-main">
                  <span class="audit-kind">
                    {KIND_LABEL[event.kind]}
                    {event.tool ? <code>{event.tool}</code> : null}
                    {event.client ? <span class="audit-client">{event.client.name}</span> : null}
                  </span>
                  <span class="audit-time">{formatRelativeTime(Date.parse(event.at), now)}</span>
                </div>
                <Badge tone={decisionTone(event.decision)}>{event.decision}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
