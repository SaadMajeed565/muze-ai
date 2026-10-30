import type { PermissionMode, PolicyConfig } from "../../libs/security/index.js";
import type { DashboardState } from "../../src/messages.js";
import type { Appearance } from "../logic.js";
import { plainCapabilities, plainGroupName } from "../ui-logic.js";
import { Callout, Chip, Segmented, Switch } from "../components/primitives.js";
import { ListRow, Page, Section } from "../components/layout.js";
import { PermissionLevelPicker } from "../PermissionLevelPicker.js";

export interface PermissionsPageProps {
  state: DashboardState;
  busy: boolean;
  appearance: Appearance;
  onAppearance: (value: Appearance) => void;
  onModeChange: (mode: PermissionMode) => void;
  onPolicyPatch: (patch: Partial<PolicyConfig>) => void;
  onReadOnly: (enabled: boolean) => void;
  onKillSwitch: (engaged: boolean) => void;
  onGroupToggle: (group: string, enabled: boolean) => void;
}

/**
 * Safety, in plain words only. There is no per-tool list here and no
 * per-tool control: "What Muze can do" is derived from the permission
 * level and the capability groups, never from tool names, categories,
 * or risk levels. The underlying policy is unchanged; only the
 * per-tool override control is not rendered.
 */
export function PermissionsPage({
  state,
  busy,
  appearance,
  onAppearance,
  onModeChange,
  onPolicyPatch,
  onReadOnly,
  onKillSwitch,
  onGroupToggle,
}: PermissionsPageProps): preact.JSX.Element {
  const { policy, snapshot } = state;
  const groups = Object.entries(policy.enabledGroups);
  const capabilities = plainCapabilities(snapshot.mode, policy.enabledGroups);

  const toggleKillSwitch = (engaged: boolean): void => {
    const ok = confirm(
      engaged
        ? "Stop all agent activity? Nothing the agent asks for will run until you turn this off again."
        : "Turn activity back on? The agent will be able to act again under the current permission level.",
    );
    if (ok) onKillSwitch(engaged);
  };

  return (
    <Page title="Safety" subtitle="What the agent may do, and how to stop it.">
      <Section title="Permission level" description="The starting point for everything the agent does.">
        <PermissionLevelPicker mode={snapshot.mode} disabled={busy} onChange={onModeChange} />
      </Section>

      <Section title="What Muze can do" description="In plain words, from your level and capabilities above.">
        <ul class="ui-list">
          {capabilities.map((capability) => (
            <ListRow key={capability} title={capability} />
          ))}
        </ul>
      </Section>

      <Section title="Safety controls">
        <div class="ui-control-row">
          <div class="ui-control-text">
            <span class="ui-control-label">Ask before acting</span>
            <span class="ui-control-hint">Ask before sensitive reads and actions that change things.</span>
          </div>
          <Switch
            checked={policy.approvalMode === "risk"}
            disabled={busy}
            label={policy.approvalMode === "risk" ? "On" : "Off"}
            onToggle={(next) => onPolicyPatch({ approvalMode: next ? "risk" : "never" })}
          />
        </div>

        <div class="ui-control-row">
          <div class="ui-control-text">
            <span class="ui-control-label">Read-only mode</span>
            <span class="ui-control-hint">Block every action that would change a page.</span>
          </div>
          <Switch checked={policy.readOnlyMode} disabled={busy} label={policy.readOnlyMode ? "On" : "Off"} onToggle={onReadOnly} />
        </div>

        <div class={"ui-control-row ui-control-row--danger" + (policy.killSwitch ? " is-on" : "")}>
          <div class="ui-control-text">
            <span class="ui-control-label">
              <span class="status-dot is-bad" aria-hidden="true" />
              Stop all activity
            </span>
            <span class="ui-control-hint">Immediately stop everything the agent asks for, until you turn it off.</span>
          </div>
          <Switch
            checked={policy.killSwitch}
            disabled={busy}
            label={policy.killSwitch ? "On" : "Off"}
            onToggle={toggleKillSwitch}
          />
        </div>

        {policy.killSwitch ? (
          <Callout tone="danger" icon="power">
            All agent activity is stopped right now. Turn this off to resume.
          </Callout>
        ) : null}
      </Section>

      {groups.length > 0 ? (
        <Section title="Capabilities" description="Optional capabilities that can be switched off together.">
          <div class="ui-chip-row">
            {groups.map(([group, enabled]) => (
              <Chip key={group} active={enabled} disabled={busy} onClick={() => onGroupToggle(group, !enabled)}>
                {plainGroupName(group)}
              </Chip>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Appearance" description="Follows your system setting by default.">
        <Segmented
          ariaLabel="Appearance"
          value={appearance}
          options={[
            { id: "system", label: "System" },
            { id: "light", label: "Light" },
            { id: "dark", label: "Dark" },
          ]}
          onChange={onAppearance}
        />
      </Section>

      <Section title="Privacy" description="What Muze AI never touches.">
        <ul class="ui-privacy-list">
          <li>Never reads saved passwords unless you ask it to work with them.</li>
          <li>Never reads local storage or other site storage on its own.</li>
          <li>Never sees the contents of network requests or responses — only which page was opened and when.</li>
          <li>Never clears browsing data, cookies or cache on its own.</li>
          <li>Runs locally: pages are read only when you ask the agent to do something.</li>
        </ul>
        <p class="ui-section-description">Changes here apply to this browser only.</p>
      </Section>
    </Page>
  );
}
