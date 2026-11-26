// Turns the pixel maps in config/icons.js into crisp SVG icons.

import { ICONS, POTATO, POTATO_COLORS } from '../config/icons.js';

const NS = 'http://www.w3.org/2000/svg';
const cache = new Map();

/** Merge each row's runs of a character into rectangles, as one SVG path. */
function pathFor(rows, ch) {
  let d = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== ch) { x++; continue; }
      let w = 1;
      while (row[x + w] === ch) w++;
      d += `M${x} ${y}h${w}v1h-${w}z`;
      x += w;
    }
  });
  return d;
}

export function icon(name, { size = 24, label } = {}) {
  const rows = ICONS[name];
  if (!rows) throw new Error(`Unknown icon: ${name}`);
  if (!cache.has(name)) cache.set(name, pathFor(rows, '#'));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${rows[0].length} ${rows.length}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', 'icon');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); }
  else svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', cache.get(name));
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

export function potato(size = 32) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('class', 'potato');
  svg.setAttribute('aria-hidden', 'true');
  for (const [ch, color] of Object.entries(POTATO_COLORS)) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', pathFor(POTATO, ch));
    path.style.fill = color;
    svg.append(path);
  }
  return svg;
}
