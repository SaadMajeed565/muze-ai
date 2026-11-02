import type { PermissionMode, PolicyConfig } from "../../libs/security/index.js";
import type { DashboardState } from "../../src/messages.js";
import type { Appearance, IconName } from "../logic.js";
import { plainCapabilities, plainGroupName } from "../ui-logic.js";
import { Button, Segmented, Switch } from "./primitives.js";
import { Icon } from "./Icon.js";
import { Section } from "./layout.js";
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
  onReset?: () => void;
}

/** Plain label for a switchable capability group. */
export function groupCapabilityLabel(group: string): string {
  if (group === "bookmarks") return "Use bookmarks";
  if (group === "history") return "Use browsing history";
  if (group === "downloads") return "Manage downloads";
  if (group === "clipboard") return "Read and write the clipboard";
  return `Use ${plainGroupName(group).toLowerCase()}`;
}

const GROUP_ICONS: Record<string, IconName> = {
  bookmarks: "bookmark",
  history: "history",
  downloads: "download",
  clipboard: "clipboard",
};

const PRIVACY_LINES = [
  "Never reads saved passwords unless you ask it to work with them.",
  "Never reads local storage or other site storage on its own.",
  "Never sees the contents of network requests or responses — only which page was opened and when.",
  "Never clears browsing data, cookies or cache on its own.",
  "Runs locally: pages are read only when you ask the agent to do something.",
];

/**
 * Permissions and safety, handled one clean way (reference): level
 * segmented control, then one switch row per capability group, then
 * one live "Muze can currently: …" line, one Reset button with its
 * meaning spelled out, and one Stop-all-activity row. No per-tool
 * list, no tool names, categories, or risk levels are ever rendered.
 * (The ask-before-acting and read-only toggles from the old layout
 * are gone from this screen by design; their policy values are
 * untouched — Reset and the level control are the ways back.)
 */
export function PermissionsSafety({
  state,
  busy,
  onModeChange,
  onKillSwitch,
  onGroupToggle,
  onReset,
}: Omit<PermissionsSectionsProps, "appearance" | "onAppearance" | "onPolicyPatch" | "onReadOnly">): preact.JSX.Element {
  const { policy, snapshot } = state;
  const groups = Object.entries(policy.enabledGroups);
  const capabilities = plainCapabilities(snapshot.mode, policy.enabledGroups);

  return (
    <>
      <Section title="Permission level" description="Applies to this browser only.">
        <PermissionLevelPicker mode={snapshot.mode} disabled={busy} onChange={onModeChange} />
      </Section>

      <Section title="What Muze can do">
        {groups.length === 0 ? (
          <p class="ui-empty-line">No switchable groups on this account.</p>
        ) : (
          <div>
            {groups.map(([group, enabled]) => (
              <div class="ui-control-row" key={group}>
                <span style={{ color: "var(--muted)" }}>
                  <Icon name={GROUP_ICONS[group] ?? "shield"} size={20} />
                </span>
                <div class="ui-control-text">
                  <span class="ui-control-label">{plainGroupName(group)}</span>
                  <span class="ui-control-hint">{groupCapabilityLabel(group)}</span>
                </div>
                <Switch
                  checked={enabled}
                  disabled={busy}
                  onToggle={(next) => onGroupToggle(group, next)}
                />
              </div>
            ))}
          </div>
        )}
        <p class="muted mt12" style={{ fontSize: "13px" }}>
          Muze can currently: {capabilities.join(", ")}.
        </p>
        <div class="mt16">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => onReset?.()}>
            Reset permissions
          </Button>
          <p class="muted" style={{ fontSize: "12px" }}>
            Reset clears per-tool decisions and turns all four groups back on. Level, kill switch, and blocked domains stay as they are.
          </p>
        </div>
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

/** Appearance + privacy: appearance segmented control, privacy as a collapsed disclosure. */
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

/** Backwards-compatible combined export (callers that render both). */
export function PermissionsSections(props: PermissionsSectionsProps): preact.JSX.Element {
  return (
    <>
      <PermissionsSafety {...props} />
      <AppearancePrivacy appearance={props.appearance} onAppearance={props.onAppearance} />
    </>
  );
}
