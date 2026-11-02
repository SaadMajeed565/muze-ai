import type { IconName } from "../logic.js";

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
  info: (
    <>
      <circle cx="12" cy="12" r="8.7" />
      <path d="M12 11v5" />
      <path d="M12 7.8h.01" />
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
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <circle cx="9" cy="9.5" r="1.5" />
      <path d="M4.5 17l4.8-4.8 3.1 3.1 2.4-2.4 4.7 4.6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 3.8h5" />
      <path d="M6.8 7l.8 13h8.8l.8-13" />
      <path d="M10 10.5v6M14 10.5v6" />
    </>
  ),
  pencil: (
    <>
      <path d="M4 20l4.3-1 10.4-10.4a2.2 2.2 0 0 0-3.1-3.1L5.2 15.9z" />
      <path d="M14.3 7.2l3.1 3.1" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  browser: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
      <path d="M3.5 9h17" />
      <path d="M6.2 6.7h.01M8.7 6.7h.01M11.2 6.7h.01" />
    </>
  ),
  app: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="2" />
      <rect x="13" y="4" width="7" height="7" rx="2" />
      <rect x="4" y="13" width="7" height="7" rx="2" />
      <path d="M16.5 13.4v6.2M13.4 16.5h6.2" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4.5" />
      <path d="M7.5 9 12 4.5 16.5 9" />
      <path d="M4.5 16v3.5h15V16" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3.5v5M15 3.5v5" />
      <path d="M6 8.5h12v3.2a6 6 0 0 1-12 0z" />
      <path d="M12 17.7v3" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4.5H6.2A1.7 1.7 0 0 0 4.5 6.2v11.6a1.7 1.7 0 0 0 1.7 1.7H14" />
      <path d="M17 8.5l3.5 3.5L17 15.5" />
      <path d="M20.5 12H10" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.7" />
      <path d="M9.6 9.2a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.9" />
      <path d="M12 16.7h.01" />
    </>
  ),
  pause: (
    <>
      <rect x="7" y="5" width="3.4" height="14" rx="1.2" />
      <rect x="13.6" y="5" width="3.4" height="14" rx="1.2" />
    </>
  ),
  play: <path d="M8 5.5v13l10-6.5z" />,
  read: (
    <>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  navigate: (
    <>
      <path d="M12 3.5l7.5 17-7.5-3.5-7.5 3.5z" />
    </>
  ),
  click: (
    <>
      <path d="M5 4l7.5 18 2.2-7.3L22 12.5z" />
      <path d="M5 4l5.2 5.2" />
    </>
  ),
  type: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M7 9h3M7 12h5M7 15h2M14 9h3M14 12h3M14 15h3" />
    </>
  ),
  tab: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 6V4.5h6V6" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v12" />
      <path d="M7.5 11.5L12 16l4.5-4.5" />
      <path d="M4.5 20h15" />
    </>
  ),
  clipboard: (
    <>
      <rect x="6" y="4" width="12" height="16" rx="2" />
      <path d="M9 4.5h6v2H9z" />
      <path d="M9 10h6M9 13h6M9 16h4" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  bookmark: (
    <>
      <path d="M6 4h12v16l-6-4-6 4z" />
    </>
  ),
  form: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M7 8h10M7 11h10M7 14h6" />
      <path d="M15 14l2 2 3-3" />
    </>
  ),
  organize: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1.4" />
      <rect x="14" y="4" width="6" height="6" rx="1.4" />
      <rect x="4" y="14" width="6" height="6" rx="1.4" />
      <rect x="14" y="14" width="6" height="6" rx="1.4" />
    </>
  ),
  activity: <path d="M3 12h4l2.5-7 4 14 2.5-7h5" />,
  folder: <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />,
  "folder-plus": (
    <>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  /* Timeline stroke set (reference): pointer w/ rays = click, keyboard
   * = typing, camera = screenshot, mouse = scroll, arrow-up-right =
   * navigation, check, X = failed. All foreground colour, no state
   * colour — the disc behind them is neutral grey. */
  pointer: (
    <>
      <path d="m9 9 5 12 1.8-5.2L21 14Z" />
      <path d="M7.2 2.2 8 5.1" />
      <path d="M5.1 8l-2.9-.8" />
      <path d="M14 4.1 12 6" />
      <path d="m5.5 11.5-1.9 3.5" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </>
  ),
  camera: (
    <>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </>
  ),
  mouse: (
    <>
      <rect x="5" y="2" width="14" height="20" rx="7" />
      <path d="M12 6v4" />
    </>
  ),
  "nav-arrow": (
    <>
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </>
  ),
  wifi: (
    <>
      <path d="M5 13a10 10 0 0 1 14 0" />
      <path d="M8.5 16.5a5 5 0 0 1 7 0" />
      <path d="M2 8.5a15 15 0 0 1 20 0" />
      <line x1="12" x2="12.01" y1="19" y2="19" />
    </>
  ),
  bulb: (
    <>
      <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
      <path d="M9 18h6" />
      <path d="M10 22h4" />
    </>
  ),
  dots: (
    <>
      <circle cx="12" cy="5" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  fail: <path d="M18 6 6 18M6 6l12 12" />,
};

export interface IconProps {
  name: IconName;
  size?: number;
  class?: string;
  strokeWidth?: number;
}

/** Inline SVG icon set — no icon dependency in the MV3 bundle. */
export function Icon({ name, size = 16, class: className, strokeWidth = 1.7 }: IconProps): preact.JSX.Element {
  // The logo is the auth-screen tile only (the header tile shows the
  // active tab icon): a monochrome M tile, never a gradient — the
  // design system has no purple gradients anywhere.
  if (name === "logo") {
    return (
      <svg
        class={"icon icon-logo" + (className ? ` ${className}` : "")}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="2.5" y="2.5" width="19" height="19" rx="6" fill="currentColor" />
        <path d="M7.2 16.8V8.4l4.8 4.6 4.8-4.6v8.4" stroke="var(--logo-on-tile, #fff)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
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
