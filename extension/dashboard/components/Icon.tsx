import type { IconName } from "../logic.js";

/* Partial: "logo" has no SVG path — Icon renders it as an <img> below, so
   the old logo path in this map was dead code and has been removed. */
const PATHS: Partial<Record<IconName, preact.ComponentChildren>> = {
  home: <path d="M3.5 10.7 12 3.5l8.5 7.2V20a1 1 0 0 1-1 1h-4.8v-6.2H9.3V21H4.5a1 1 0 0 1-1-1z" />,
  shield: (
    <>
      <path d="M12 3.2 19 6.1v5.6c0 4.4-2.9 7.4-7 9.1-4.1-1.7-7-4.7-7-9.1V6.1z" />
      <path d="M9 12.2l2.1 2.1L15.3 10" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
    </>
  ),
  pulse: <path d="M2.5 12.5H7l2.4-6.6 4.3 12.2 2.3-5.6h5.5" />,
  check: <path d="M4.5 12.6l4.7 4.7L19.5 6.9" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  copy: (
    <>
      <rect x="9" y="9" width="11.5" height="11.5" rx="2.2" />
      <path d="M15.5 5.5H6.2A2.2 2.2 0 0 0 4 7.7v9.3" />
    </>
  ),
  eye: (
    <>
      <path d="M2.2 12S6 5.8 12 5.8 21.8 12 21.8 12 18 18.2 12 18.2 2.2 12 2.2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M6.4 6.7C3.9 8.4 2.2 12 2.2 12s3.8 6.2 9.8 6.2c2 0 3.7-.7 5.1-1.7" />
      <path d="M19.6 15.1c1.4-1.4 2.2-3.1 2.2-3.1s-3.8-6.2-9.8-6.2c-.8 0-1.6.1-2.3.3" />
      <path d="M3.5 3.5l17 17" />
      <path d="M10 10a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.8" />
      <path d="M20.5 20.5l-4.9-4.9" />
    </>
  ),
  refresh: (
    <>
      <path d="M20.4 12a8.4 8.4 0 1 1-2.5-6" />
      <path d="M20.4 4.4V10h-5.6" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4.2 21 20H3z" />
      <path d="M12 10v4.2" />
      <path d="M12 17.2h.01" />
    </>
  ),
  "arrow-left": (
    <>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </>
  ),
  "arrow-right": (
    <>
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </>
  ),
  "chevron-right": <path d="M9.5 5.5l6.5 6.5-6.5 6.5" />,
  "chevron-left": <path d="M14.5 5.5L8 12l6.5 6.5" />,
  link: (
    <>
      <path d="M10.2 13.8a4.6 4.6 0 0 0 6.5 0l2-2a4.6 4.6 0 0 0-6.5-6.5l-1 1" />
      <path d="M13.8 10.2a4.6 4.6 0 0 0-6.5 0l-2 2a4.6 4.6 0 0 0 6.5 6.5l1-1" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.9" />
      <path d="M4.5 20.5c.7-3.6 3.8-5.6 7.5-5.6s6.8 2 7.5 5.6" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="10.5" rx="2.2" />
      <path d="M8 10V7.2a4 4 0 0 1 8 0V10" />
    </>
  ),
  external: (
    <>
      <path d="M14.5 4.5h5v5" />
      <path d="M19.5 4.5l-8 8" />
      <path d="M18 14v5.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H11" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7.5h8.5M17.5 7.5H20M4 16.5h3.5M12.5 16.5H20" />
      <circle cx="15" cy="7.5" r="2.4" />
      <circle cx="10" cy="16.5" r="2.4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.2V12l3.4 2" />
    </>
  ),
  power: (
    <>
      <path d="M12 3.5v8.3" />
      <path d="M7.4 6.6a7.4 7.4 0 1 0 9.2 0" />
    </>
  ),
  key: (
    <>
      <circle cx="8.2" cy="8.2" r="4.2" />
      <path d="M11.3 11.3L20.5 20.5" />
      <path d="M17.6 17.6l2-2M14.6 14.6l2-2" />
    </>
  ),
  file: (
    <>
      <path d="M13.6 3.5H7a1.8 1.8 0 0 0-1.8 1.8v13.4A1.8 1.8 0 0 0 7 20.5h10a1.8 1.8 0 0 0 1.8-1.8V8.7z" />
      <path d="M13.4 3.6v5.1h5.2" />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  size?: number;
  class?: string;
  strokeWidth?: number;
}

/** Inline SVG icon set — no icon dependency in the MV3 bundle. */
export function Icon({ name, size = 16, class: className, strokeWidth = 1.7 }: IconProps): preact.JSX.Element {
  if (name === "logo") {
    return (
      <img
        src="icons/icon128.png"
        alt=""
        aria-hidden="true"
        class={"icon icon-logo" + (className ? ` ${className}` : "")}
        width={size}
        height={size}
        style={{ display: "block", borderRadius: "20%" }}
      />
    );
  }
  return (
    <svg
      class={"icon" + (className ? ` ${className}` : "")}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={strokeWidth}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
