/** 线性图标（24×24，描边 1.8），颜色跟随文字。 */
const PATHS: Record<string, string> = {
  overview: '<rect x="3" y="3" width="7.5" height="9" rx="2"/><rect x="13.5" y="3" width="7.5" height="5" rx="2"/><rect x="3" y="15" width="7.5" height="6" rx="2"/><rect x="13.5" y="11" width="7.5" height="10" rx="2"/>',
  cooling: '<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 1-7 4-7 2 0 3 2 2 4l-4 4M14 12c4 0 7 1 7 4 0 2-2 3-4 2l-4-4M12 14c0 4-1 7-4 7-2 0-3-2-2-4l4-4M10 12c-4 0-7-1-7-4 0-2 2-3 4-2l4 4"/>',
  lighting: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M6 9h12M6 15h12"/>',
  screen: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 15l3-3 2 2 3-4"/>',
  devices: '<path d="M5 12a7 7 0 0 1 14 0M8 12a4 4 0 0 1 8 0"/><circle cx="12" cy="12" r="1.2"/><path d="M12 13v7"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
  gauge: '<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 9"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9l5 3-5 3z"/>',
  off: '<circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/>',
  upload: '<path d="M12 15V4M7 9l5-5 5 5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  pump: '<rect x="5" y="5" width="14" height="14" rx="4"/><circle cx="12" cy="12" r="3"/>',
  fan: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 10c0-3 1-5 3-5M14 12c3 0 5 1 5 3M12 14c0 3-1 5-3 5M10 12c-3 0-5-1-5-3"/>',
  fans: '<circle cx="8" cy="12" r="5"/><circle cx="15.5" cy="12" r="5"/><circle cx="8" cy="12" r="1.4"/><circle cx="15.5" cy="12" r="1.4"/>',
  radio: '<rect x="8" y="10" width="8" height="11" rx="2"/><path d="M12 10V6M8 5a6 6 0 0 1 8 0M6 3a9 9 0 0 1 12 0"/>',
  ring: '<rect x="3.5" y="6" width="17" height="12" rx="6"/><rect x="8.5" y="9.5" width="7" height="5" rx="2.5"/>',
  ring88: '<rect x="2.5" y="7" width="19" height="10" rx="5"/><rect x="9" y="10.5" width="6" height="3" rx="1.5"/>',
  rename: '<path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5 17 10"/>',
  locate: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  power: '<path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0"/>',
};

export function icon(name: keyof typeof PATHS | string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = PATHS[name] ?? "";
  return svg;
}
