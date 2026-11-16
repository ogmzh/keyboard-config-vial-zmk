// Draws a keyboard from a layout ([{x, y, w, h, r, rx, ry}] in key units) with one cap per key.
// Sizes are in em, so the whole board scales with the font-size of its container.

import { h } from './dom.js';

const rad = (d) => (d * Math.PI) / 180;

function bounds(layout) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const k of layout) {
    const w = k.w || 1; const hh = k.h || 1;
    const ox = k.rx ?? k.x; const oy = k.ry ?? k.y;
    const a = rad(k.r || 0);
    for (const [px, py] of [[k.x, k.y], [k.x + w, k.y], [k.x, k.y + hh], [k.x + w, k.y + hh]]) {
      const dx = px - ox; const dy = py - oy;
      const x = ox + dx * Math.cos(a) - dy * Math.sin(a);
      const y = oy + dx * Math.sin(a) + dy * Math.cos(a);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

const sizeClass = (s) => { const n = [...String(s || '')].length; return n <= 1 ? 's1' : n <= 3 ? 's3' : n <= 6 ? 's6' : n <= 10 ? 's10' : 's14'; };

// caps: [{ tag, main, sub, kind, title, status, selected, dim }]
export function keyboardView({ layout, caps, onKey, maxUnit = 74, minUnit = 30, label = 'Keyboard', interactive = true }) {
  const b = bounds(layout);
  const board = h('div', { class: 'board', role: 'group', 'aria-label': label, style: { width: `${b.width}em`, height: `${b.height}em` } });
  layout.forEach((k, i) => {
    const cap = caps[i] || { kind: 'none', main: '' };
    const w = k.w || 1; const hh = k.h || 1;
    const style = { left: `${k.x - b.minX}em`, top: `${k.y - b.minY}em`, width: `${w}em`, height: `${hh}em` };
    if (k.r) { style.transformOrigin = `${(k.rx ?? k.x) - k.x}em ${(k.ry ?? k.y) - k.y}em`; style.transform = `rotate(${k.r}deg)`; }
    const face = h(interactive ? 'button' : 'div', {
      class: `cap k-${cap.kind || 'alpha'} ${cap.status ? 'st-' + cap.status : ''} ${cap.selected ? 'selected' : ''} ${cap.dim ? 'dim' : ''}`,
      type: interactive ? 'button' : undefined,
      title: cap.title || '',
      'aria-label': `Key ${i}: ${cap.title || cap.main || 'empty'}`,
      onClick: interactive && onKey ? (e) => onKey(i, e) : undefined,
    },
    cap.tag ? h('span', { class: 'cap-tag' }, cap.tag) : null,
    h('span', { class: `cap-main ${sizeClass(cap.main)}` }, cap.main || ''),
    cap.sub ? h('span', { class: 'cap-sub' }, cap.sub) : null,
    cap.status && cap.status !== 'ok' ? h('span', { class: 'cap-flag', 'aria-hidden': 'true' }) : null);
    board.append(h('div', { class: 'slot', style }, face));
  });
  const wrap = h('div', { class: 'board-wrap' }, board);
  const fit = () => {
    const avail = wrap.clientWidth;
    if (!avail) return;
    const unit = Math.max(minUnit, Math.min(maxUnit, Math.floor((avail / b.width) * 100) / 100));
    board.style.fontSize = unit + 'px';
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(wrap);
  requestAnimationFrame(fit);
  return wrap;
}
