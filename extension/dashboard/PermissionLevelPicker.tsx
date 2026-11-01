import type { PermissionMode } from "../libs/security/index.js";
import { MODE_OPTIONS } from "./logic.js";
import { Icon } from "./components/Icon.js";
import { Segmented } from "./components/primitives.js";
import { useConfirm } from "./components/confirm.js";

export interface PermissionLevelPickerProps {
  mode: PermissionMode;
  disabled?: boolean;
  variant?: "cards" | "inline";
  onChange: (mode: PermissionMode) => void;
}

/**
 * The permission level picker, in both places it is needed: three large
 * selectable cards during onboarding and a compact control on the
 * Permissions tab. The same options back both, so the copy cannot drift.
 */
export function PermissionLevelPicker({
  mode,
  disabled,
  variant = "inline",
  onChange,
}: PermissionLevelPickerProps): preact.JSX.Element {
  const active = MODE_OPTIONS.find((option) => option.id === mode) ?? MODE_OPTIONS[1];
  const confirm = useConfirm();

  /**
   * Switching to Unrestricted removes every approval step, so it asks
   * through the app's own confirmation sheet. This covers both picker
   * placements (onboarding cards and Me > Permissions and safety).
   */
  const change = async (next: PermissionMode): Promise<void> => {
    if (next === "unrestricted" && mode !== "unrestricted") {
      const ok = await confirm({
        title: "Switch to Unrestricted?",
        body: "Every tool will run without a confirmation step, including reads of personal data. Only use this on a machine you trust.",
        confirmLabel: "Use Unrestricted",
        tone: "danger",
      });
      if (!ok) return;
    }
    onChange(next);
  };

  if (variant === "cards") {
    return (
      <div class="level-cards" role="radiogroup" aria-label="Permission level">
        {MODE_OPTIONS.map((option) => {
          const selected = option.id === mode;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              class={"level-card" + (selected ? " is-on" : "")}
              disabled={disabled}
              onClick={() => void change(option.id)}
            >
              <span class="level-card-top">
                <span class="level-card-label">{option.label}</span>
                <span class="level-card-check" aria-hidden="true">
                  {selected ? <Icon name="check" size={14} strokeWidth={2.4} /> : null}
                </span>
              </span>
              <span class="level-card-summary">{option.summary}</span>
              <ul class="level-card-detail">
                {option.detail.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div class="level-inline">
      <Segmented
        ariaLabel="Permission level"
        value={mode}
        disabled={disabled}
        options={MODE_OPTIONS.map((option) => ({ id: option.id, label: option.label, hint: option.summary }))}
        onChange={(next) => void change(next)}
      />
      <p class="level-description">{active.summary}</p>
      <ul class="level-detail">
        {active.detail.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
