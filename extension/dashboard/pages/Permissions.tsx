import type { PermissionMode, PolicyConfig } from "../../libs/security/index.js";
import type { DashboardState } from "../../src/messages.js";
import { Button, Callout, Card, Chip, Switch } from "../components/primitives.js";
import { PermissionLevelPicker } from "../PermissionLevelPicker.js";

export interface PermissionsPageProps {
  state: DashboardState;
  busy: boolean;
  onModeChange: (mode: PermissionMode) => void;
  onPolicyPatch: (patch: Partial<PolicyConfig>) => void;
  onReadOnly: (enabled: boolean) => void;
  onKillSwitch: (engaged: boolean) => void;
  onGroupToggle: (group: string, enabled: boolean) => void;
  onReset: () => void;
}

export function PermissionsPage({
  state,
  busy,
  onModeChange,
  onPolicyPatch,
  onReadOnly,
  onKillSwitch,
  onGroupToggle,
  onReset,
}: PermissionsPageProps): preact.JSX.Element {
  const { policy, snapshot } = state;
  const groups = Object.entries(policy.enabledGroups);
  const overrideCount = Object.keys(policy.toolOverrides ?? {}).length;

  /**
   * Native confirm() dialogs for privilege-changing actions (documented:
   * this dashboard has no custom dialog component). Engaging the kill
   * switch refuses every tool call; disengaging it re-enables the agent,
   * so both directions confirm. Resetting overrides discards choices the
   * user made tool by tool. (Unrestricted switching confirms inside
   * PermissionLevelPicker, which both picker placements share.)
   */
  const toggleKillSwitch = (engaged: boolean): void => {
    const ok = confirm(
      engaged
        ? "Engage the emergency stop? Every tool call will be refused until you turn it off again."
        : "Turn the emergency stop off? The agent will be able to act again under the current permission level.",
    );
    if (ok) onKillSwitch(engaged);
  };

  const resetOverrides = (): void => {
    if (overrideCount === 0) return;
    const ok = confirm(`Reset all ${overrideCount} per-tool override${overrideCount === 1 ? "" : "s"}? Every tool goes back under the current permission level.`);
    if (ok) onReset();
  };

  return (
    <div class="stack">
      <Card
        title="Permission level"
        description="The starting point for every tool call. Per-tool overrides sit on top of it."
        actions={<span class="pill">{snapshot.toolCount} tools</span>}
      >
        <PermissionLevelPicker mode={snapshot.mode} disabled={busy} onChange={onModeChange} />
      </Card>

      <Card title="Safety controls">
        <div class="control-row">
          <div class="control-text">
            <span class="control-label">Approval prompts</span>
            <span class="control-hint">Ask before sensitive reads and consequential actions.</span>
          </div>
          <Switch
            checked={policy.approvalMode === "risk"}
            disabled={busy}
            label={policy.approvalMode === "risk" ? "On" : "Off"}
            onToggle={(next) => onPolicyPatch({ approvalMode: next ? "risk" : "never" })}
          />
        </div>

        <div class="control-row">
          <div class="control-text">
            <span class="control-label">Read-only mode</span>
            <span class="control-hint">Block every action that would change the page.</span>
          </div>
          <Switch checked={policy.readOnlyMode} disabled={busy} label={policy.readOnlyMode ? "On" : "Off"} onToggle={onReadOnly} />
        </div>

        <div class={"control-row control-row--danger" + (policy.killSwitch ? " is-on" : "")}>
          <div class="control-text">
            <span class="control-label">
              <span class="status-dot is-bad" aria-hidden="true" />
              Emergency stop
            </span>
            <span class="control-hint">Immediately refuse every tool call until you turn it off.</span>
          </div>
          <Switch
            checked={policy.killSwitch}
            disabled={busy}
            label={policy.killSwitch ? "Engaged" : "Off"}
            onToggle={toggleKillSwitch}
          />
        </div>

        {policy.killSwitch ? (
          <Callout tone="danger" icon="power">
            All tool calls are being refused right now. Turn the emergency stop off to resume.
          </Callout>
        ) : null}
      </Card>

      {groups.length > 0 ? (
        <Card title="Permission groups" description="Optional capabilities that can be switched off together.">
          <div class="chip-row">
            {groups.map(([group, enabled]) => (
              <Chip key={group} active={enabled} disabled={busy} onClick={() => onGroupToggle(group, !enabled)}>
                {group}
              </Chip>
            ))}
          </div>
        </Card>
      ) : null}

      <Card
        title="Per-tool overrides"
        description={
          overrideCount > 0
            ? `${overrideCount} tool${overrideCount === 1 ? "" : "s"} differ from the level above.`
            : "No individual tools have been changed yet."
        }
        actions={
          <Button variant="ghost" size="sm" icon="refresh" disabled={busy || overrideCount === 0} onClick={resetOverrides}>
            Reset overrides
          </Button>
        }
      >
        <p class="hint">Overrides survive every level change, so switching the level never discards a choice you made. Reset puts every tool back under the level.</p>
      </Card>
    </div>
  );
}
