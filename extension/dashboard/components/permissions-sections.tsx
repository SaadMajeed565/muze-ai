import type { PermissionMode, PolicyConfig } from "../../libs/security/index.js";
import type { DashboardState } from "../../src/messages.js";
import type { Appearance } from "../logic.js";
import { plainCapabilities, plainGroupName } from "../ui-logic.js";
import { Segmented, Switch } from "./primitives.js";
import { ListRow, Section } from "./layout.js";
import { PermissionLevelPicker } from "../PermissionLevelPicker.js";
import { PauseControl } from "./shared.js";

export interface PermissionsSectionsProps {
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

/** Plain label for a switchable capability group. */
export function groupCapabilityLabel(group: string): string {
  if (group === "bookmarks") return "Use bookmarks";
  if (group === "history") return "Use browsing history";
  if (group === "downloads") return "Manage downloads";
  if (group === "clipboard") return "Read and write the clipboard";
  return `Use ${plainGroupName(group).toLowerCase()}`;
}

const PRIVACY_LINES = [
  "Never reads saved passwords unless you ask it to work with them.",
  "Never reads local storage or other site storage on its own.",
  "Never sees the contents of network requests or responses — only which page was opened and when.",
  "Never clears browsing data, cookies or cache on its own.",
  "Runs locally: pages are read only when you ask the agent to do something.",
];

/**
 * Permissions and safety (v3), labelled "Applies to this browser
 * only" by its caller. The level cards, the "on top of your level"
 * switches, and ONE merged "What Muze can do" list: level-derived
 * items are plain rows, each switchable group gets a real switch, and
 * there is no separate chip row. Stop all activity is the shared
 * PauseControl with the existing kill-switch semantics — never a bare
 * "Off" toggle. The underlying policy is unchanged; only layout and
 * wording changed. No per-tool list, no tool names, categories, or
 * risk levels are ever rendered.
 */
export function PermissionsSafety({
  state,
  busy,
  onModeChange,
  onPolicyPatch,
  onReadOnly,
  onKillSwitch,
  onGroupToggle,
}: Omit<PermissionsSectionsProps, "appearance" | "onAppearance">): preact.JSX.Element {
  const { policy, snapshot } = state;
  const levelCapabilities = plainCapabilities(snapshot.mode, {});
  const groups = Object.entries(policy.enabledGroups);

  return (
    <>
      <Section title="Permission level" description="The starting point for everything the agent does.">
        <PermissionLevelPicker mode={snapshot.mode} disabled={busy} onChange={onModeChange} />
      </Section>

      <Section title="On top of your level" description="These apply on top of your level.">
        <div class="ui-control-row">
          <div class="ui-control-text">
            <span class="ui-control-label">Ask before acting</span>
            <span class="ui-control-hint">Ask before sensitive reads and actions that change things.</span>
          </div>
          <Switch
            checked={policy.approvalMode === "risk"}
            disabled={busy}
            onToggle={(next) => onPolicyPatch({ approvalMode: next ? "risk" : "never" })}
          />
        </div>
        <div class="ui-control-row">
          <div class="ui-control-text">
            <span class="ui-control-label">Read-only mode</span>
            <span class="ui-control-hint">Block every action that would change a page.</span>
          </div>
          <Switch checked={policy.readOnlyMode} disabled={busy} onToggle={onReadOnly} />
        </div>
      </Section>

      <Section title="What Muze can do" description="In plain words, from your level and capabilities.">
        <ul class="ui-list">
          {levelCapabilities.map((capability) => (
            <ListRow key={capability} title={capability} />
          ))}
        </ul>
        {groups.length > 0 ? (
          <div class="ui-control-list">
            {groups.map(([group, enabled]) => (
              <div class="ui-control-row" key={group}>
                <div class="ui-control-text">
                  <span class="ui-control-label">{groupCapabilityLabel(group)}</span>
                </div>
                <Switch
                  checked={enabled}
                  disabled={busy}
                  onToggle={(next) => onGroupToggle(group, next)}
                />
              </div>
            ))}
          </div>
        ) : null}
      </Section>

      <Section title="Stop all activity" description={policy.killSwitch ? "Paused" : "Agent is active"}>
        <div class="ui-control-row">
          <div class="ui-control-text">
            <span class="ui-control-label">Stop all activity</span>
            <span class="ui-control-hint">Immediately stop everything the agent asks for, until you resume.</span>
          </div>
          <PauseControl paused={policy.killSwitch} busy={busy} onToggle={onKillSwitch} />
        </div>
      </Section>
    </>
  );
}

/** Appearance + privacy (v3): appearance segmented control, privacy as a collapsed disclosure. */
export function AppearancePrivacy({
  appearance,
  onAppearance,
}: {
  appearance: Appearance;
  onAppearance: (value: Appearance) => void;
}): preact.JSX.Element {
  return (
    <>
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

      <details class="ui-disclosure">
        <summary class="ui-disclosure-summary">Privacy</summary>
        <ul class="ui-privacy-list">
          {PRIVACY_LINES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p class="ui-section-description">Changes here apply to this browser only.</p>
      </details>
    </>
  );
}

/** Backwards-compatible combined export (v2 callers): safety + appearance + privacy. */
export function PermissionsSections(props: PermissionsSectionsProps): preact.JSX.Element {
  return (
    <>
      <PermissionsSafety {...props} />
      <AppearancePrivacy appearance={props.appearance} onAppearance={props.onAppearance} />
    </>
  );
}
