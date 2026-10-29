/**
 * The shell's icon set.
 *
 * Every glyph is inline SVG on a 24px grid with a 1.6px stroke, so icons inherit
 * `currentColor` and a stroke weight that matches the type around them. Nothing
 * depends on a font or an icon package being installed, and no glyph is a letter
 * standing in for a picture.
 *
 * Icons are decoration: each one is `aria-hidden` and carries no text, because
 * the control that owns it supplies the accessible name (ui-pattern.md,
 * "Responsive and Accessibility Requirements"). An unknown name renders nothing
 * rather than a broken box, so a missing mapping degrades to no icon.
 */
const GLYPHS = {
  // Navigation and identity.
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
    </>
  ),
  pin: (
    <>
      <path d="M9.5 3.5h5l-.8 5.2 3.3 3.3H7l3.3-3.3z" />
      <path d="M12 12v8.5" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9M17.2 7h2.8M4 17h2.8M11 17h9" />
      <circle cx="15" cy="7" r="2.2" />
      <circle cx="9" cy="17" r="2.2" />
    </>
  ),
  close: <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />,
  chevronUp: <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />,
  chevronDown: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  chevronLeft: <path d="m14.5 6.5-5.5 5.5 5.5 5.5" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
    </>
  ),
  moon: <path d="M20 13.4A8.4 8.4 0 0 1 10.6 4a8.5 8.5 0 1 0 9.4 9.4z" />,

  // Tools.
  map: (
    <>
      <path d="M9 3.6 3.5 5.8v14.6L9 18.2l6 2.2 5.5-2.2V3.6L15 5.8z" />
      <path d="M9 3.6v14.6M15 5.8v14.6" />
    </>
  ),
  layout: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M3.5 12h7.5M11 3.5v17" />
    </>
  ),
  server: (
    <>
      <rect x="3.5" y="4" width="17" height="6.5" rx="1.6" />
      <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.6" />
      <path d="M7 7.25h.01M7 16.75h.01" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="5" cy="5" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M6.5 6.5 10 10M17.5 6.5 14 10M6.5 17.5 10 14M17.5 17.5 14 14" />
    </>
  ),
  route: (
    <>
      <path d="M4 19h4.5a3 3 0 0 0 3-3v-8a3 3 0 0 1 3-3H19" />
      <circle cx="4" cy="19" r="1.7" />
      <circle cx="19.5" cy="5" r="1.7" />
    </>
  ),
  plug: (
    <>
      <path d="M9 3v6M15 3v6" />
      <path d="M6.5 9h11v3a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 17.5V21" />
    </>
  ),
  zap: <path d="M13.5 3 5 13.5h5.5L10.5 21 19 10.5h-5.5z" />,
  thermometer: (
    <>
      <path d="M14 14.8V5.5a2 2 0 1 0-4 0v9.3a4.5 4.5 0 1 0 4 0z" />
      <path d="M12 9.5v6.5" />
    </>
  ),
  /**
   * The active-tool commands. These are their own glyphs rather than borrowings.
   *
   * `map`, `upload`, and `send` were doing double duty — the first is the basemap
   * control, the second is Add files, the third is Share — so a toolbar wearing them
   * named the tool it was drawn from rather than the tool it runs. Each command is a
   * schematic of what it does instead:
   *
   *   * a connection point is a node on a supply line;
   *   * a footprint is a shape whose corners are handles, which is what is true of it
   *     while it is being drawn;
   *   * import brings content in and publish releases it, so they are the same tray with
   *     the arrow reversed, and the pair is legible as a pair.
   */
  /** Stacked sheets: the universal reading of "layers", and what the control toggles. */
  layers: (
    <>
      <path d="M12 3.4 3.5 7.6l8.5 4.2 8.5-4.2z" />
      <path d="m3.5 12.2 8.5 4.2 8.5-4.2" />
    </>
  ),
  addInterface: (
    <>
      <path d="M3.5 12h5.2" />
      <circle cx="12" cy="12" r="3.3" />
      <path d="M15.3 12h5.2" />
    </>
  ),
  drawFootprint: (
    <>
      <path d="M4.5 7.5 10 4.5h9.5v12L14 19.5H4.5z" />
      <rect x="3.1" y="6.1" width="2.8" height="2.8" rx="0.7" />
      <rect x="18.1" y="15.1" width="2.8" height="2.8" rx="0.7" />
    </>
  ),
  importAsset: (
    <>
      <path d="M4.5 14.5v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3.5" />
      <path d="M12 3.5v10.5M7.8 9.8 12 14l4.2-4.2" />
    </>
  ),
  validateRevision: (
    <>
      <path d="M9 4.6H7.6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8.8a2 2 0 0 0 2-2v-11a2 2 0 0 0-2-2H15" />
      <rect x="9" y="2.9" width="6" height="3.4" rx="1" />
      <path d="m9.3 12.7 2 2 3.8-4" />
    </>
  ),
  publishRevision: (
    <>
      <path d="M4.5 14.5v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3.5" />
      <path d="M12 14.2V3.7M7.8 7.9 12 3.7l4.2 4.2" />
    </>
  ),
  shieldCheck: (
    <>
      <path d="M12 3.2 5 6v5.5c0 4.2 3 8 7 9.3 4-1.3 7-5.1 7-9.3V6z" />
      <path d="m9 11.8 2.2 2.2 4.3-4.4" />
    </>
  ),
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h3.2l2 2.5h7.8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  list: (
    <>
      <path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11" />
      <path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />
    </>
  ),
  chart: (
    <>
      <path d="M4 4v16h16" />
      <rect x="7.5" y="12" width="3" height="5" rx="1" />
      <rect x="13" y="8" width="3" height="9" rx="1" />
    </>
  ),
  pulse: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  coins: (
    <>
      <ellipse cx="12" cy="6.5" rx="7" ry="3" />
      <path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
      <path d="M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
    </>
  ),
  rocket: (
    <>
      <path d="M12 3c3.2 1.7 5 5 5 8.6 0 2-.7 3.9-1.8 5.4H8.8A9.6 9.6 0 0 1 7 11.6C7 8 8.8 4.7 12 3z" />
      <circle cx="12" cy="10" r="1.8" />
      <path d="m9 17-2 4 3.5-1.5M15 17l2 4-3.5-1.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="5.5" r="2.5" />
      <circle cx="7" cy="18.5" r="2.5" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M7 8v8M17 11.5a5 5 0 0 1-5 5H7" />
    </>
  ),

  // Actions and status.
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  minus: <path d="M5.5 12h13" />,
  upload: (
    <>
      <path d="M12 16.5V4.5M7.5 9 12 4.5 16.5 9" />
      <path d="M4.5 15.5v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" />
    </>
  ),
  send: (
    <>
      <path d="M20.5 3.5 3.5 10.5l6.5 2.5 2.5 6.5z" />
      <path d="m10 13 4.5-4.5" />
    </>
  ),
  sparkle: (
    <>
      <path d="M11 3.5 12.7 8.3 17.5 10 12.7 11.7 11 16.5 9.3 11.7 4.5 10 9.3 8.3z" />
      <path d="M18 15.5 18.7 17.3 20.5 18 18.7 18.7 18 20.5 17.3 18.7 15.5 18 17.3 17.3z" />
    </>
  ),
  check: <path d="m5.5 12.5 4.5 4.5 8.5-9" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 5.5h-9a2 2 0 0 0-2 2v9" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.5 2.5 4.5-5" />
    </>
  ),
  alertCircle: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5M12 16.3h.01" />
    </>
  ),
  // The conventional information mark. The stem runs the opposite way from
  // alertCircle's, which is the whole of what distinguishes "there is something here to
  // read" from "something is wrong".
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11.4v5.1M12 7.7h.01" />
    </>
  ),
  alertTriangle: (
    <>
      <path d="M12 4.2 2.8 20h18.4z" />
      <path d="M12 10v4.2M12 17.2h.01" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="3.2" />,
  spinner: (
    <path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.8 2.8M15.2 15.2 18 18M18 6l-2.8 2.8M8.8 15.2 6 18" />
  ),
};

export function Icon({ name, size = 16, className = null, strokeWidth = 1.6 }) {
  const glyph = GLYPHS[name];
  if (!glyph) return null;

  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyph}
    </svg>
  );
}

/**
 * A tool's icon. The mapping lives here rather than in the tool registry so the
 * registry stays domain state and the shell keeps its own presentation, and an
 * unmapped tool falls back to the neutral grid rather than a blank slot.
 */
const TOOL_ICONS = Object.freeze({
  site_facility: 'map',
  floorplan: 'layout',
  rack: 'server',
  network: 'network',
  route_pathway: 'route',
  cabling: 'plug',
  power: 'zap',
  thermal_hvac: 'thermometer',
  verify: 'shieldCheck',
  assets: 'folder',
  catalog: 'list',
  workload: 'chart',
  simulation: 'pulse',
  cost_schedule: 'coins',
  deployment: 'rocket',
  changes: 'branch',
});

export function toolIcon(toolId) {
  return TOOL_ICONS[toolId] ?? 'grid';
}

/** A toolbar command's icon, or null when the command is text-only. */
const COMMAND_ICONS = Object.freeze({
  rack_add: 'server',
  rack_device: 'plug',
  rack_zone: 'layout',
  rack_constraints: 'sliders',
  rack_capacity: 'chart',
  rack_design: 'grid',
  rack_checks: 'shieldCheck',
  add_interface: 'addInterface',
  draw_footprint: 'drawFootprint',
  import: 'importAsset',
  validate: 'validateRevision',
  publish: 'publishRevision',
});

export function commandIcon(commandId) {
  return COMMAND_ICONS[commandId] ?? null;
}

export { GLYPHS };
