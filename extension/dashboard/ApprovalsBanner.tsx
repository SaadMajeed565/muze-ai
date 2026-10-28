import { useEffect, useState } from "preact/hooks";
import type { ApprovalRequestInfo } from "../libs/tool-contracts/index.js";
import { formatCountdown } from "./logic.js";
import { Icon } from "./components/Icon.js";
import { Button } from "./components/primitives.js";

export interface ApprovalsBannerProps {
  approvals: ApprovalRequestInfo[];
  busy: boolean;
  onRespond: (approvalId: string, approved: boolean) => void;
  onReview: () => void;
}

/**
 * Sticky, always-visible notice for requests waiting on the user. Approvals
 * expire after two minutes, so the first one gets inline Approve/Deny and the
 * rest route to the Activity tab.
 */
export function ApprovalsBanner({ approvals, busy, onRespond, onReview }: ApprovalsBannerProps): preact.JSX.Element | null {
  // Countdowns tick on their own 1s timer. Previously they only moved on
  // the 5s dashboard poll or a service-worker event, so a 120s approval
  // could look fresh long after it was nearly expired.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (approvals.length === 0) return null;

  const first = approvals[0];
  const count = approvals.length;

  return (
    <div class="approval-banner" role="status" aria-live="polite">
      <span class="approval-banner-icon" aria-hidden="true">
        <Icon name="alert" size={17} />
      </span>
      <div class="approval-banner-body">
        <p class="approval-banner-title">
          {count === 1 ? `${first.title} needs approval` : `${count} requests are waiting for approval`}
        </p>
        <p class="approval-banner-meta">
          <span>{first.client.name}</span>
          <span aria-hidden="true">·</span>
          <code>{first.tool}</code>
          <span aria-hidden="true">·</span>
          <span>{formatCountdown(first.expiresAt, now)}</span>
        </p>
        {count === 1 ? <p class="approval-banner-summary">{first.summary}</p> : null}
      </div>
      <div class="approval-banner-actions">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onRespond(first.id, false)}>
          Deny
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => onRespond(first.id, true)}>
          Approve
        </Button>
        {count > 1 ? (
          <Button variant="secondary" size="sm" icon="chevron-right" disabled={busy} onClick={onReview}>
            All {count}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
