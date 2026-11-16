// Shows what is plugged in: the badge in the top bar, the detail lines in the side panels, and the dialog.
// The page is rebuilt often, so these pieces do not subscribe to anything: each one is tagged, and
// refreshConnection() redraws every tagged piece that is on the page when the picture changes.

import { h, modal, toast, confirmDialog } from './dom.js';
import { zmkStatus, vialStatus } from '../core/connection.js';

export function statusFor(app, target = app.target) {
  const conn = app.watch.conn;
  return target === 'vial' ? vialStatus(conn, app.vialTarget) : zmkStatus(conn, app.keyboardName);
}

export function refreshConnection() {
  for (const el of document.querySelectorAll('[data-conn]')) if (el.redraw) el.redraw();
}

// A piece of the page that is redrawn whenever the connection picture changes.
export function live(el, draw) {
  el.dataset.conn = '1';
  el.redraw = draw;
  draw();
  return el;
}

const halves = (st) => h('span', { class: 'halves', 'aria-hidden': 'true' }, h('i', { class: st.glyph.left }, 'L'), h('i', { class: st.glyph.right }, 'R'));

// Top bar: two small halves and a few words, for the keyboard that is selected. Click for the details.
export function connectionBadge(app) {
  const el = h('button', { onClick: () => connectionDialog(app) });
  return live(el, () => {
    const st = statusFor(app);
    el.className = `conn-badge tone-${st.tone}`;
    el.title = st.lines.map((l) => l.text).join('\n');
    el.setAttribute('aria-label', `${st.label}. Show what is plugged in`);
    el.replaceChildren(halves(st), h('span', { class: 'conn-label' }, st.label));
  });
}

// The same thing in full: every line, and for the Vial keyboard the buttons to check and mark the half.
export function connectionDetail(app, target = app.target) {
  const el = h('div', { class: 'conn-detail', 'aria-live': 'polite' });
  const run = (fn) => async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { await fn(); } catch (err) { toast(err.message || String(err), 'error', 9000); }
    b.disabled = false;
  };
  const mark = (side) => run(async () => {
    const ok = await confirmDialog(`Mark the plugged-in half as the ${side} one?`, `Mark as ${side}`, {
      detail: `Look at which half the USB cable is in. The app stores one hidden note on that half (on layer ${app.vialTarget.sideCell.layer + 1}, at a spot that has no switch). None of your keys change.`,
    });
    if (!ok) return;
    await app.watch.mark(side);
    toast(`Marked as the ${side} half.`, 'ok');
  });
  return live(el, () => {
    const st = statusFor(app, target);
    const buttons = [];
    if (st.actions.includes('check')) buttons.push(h('button', { onClick: run(() => app.watch.check()) }, 'Check which half'));
    if (st.actions.includes('name')) {
      const name = (side) => run(async () => { await app.watch.name(st.serial, side); if (side) toast(`Got it: this is the ${side} half.`, 'ok'); });
      for (const side of ['left', 'right']) if (st.marked !== side) buttons.push(h('button', { onClick: name(side) }, st.marked ? `No, this is the ${side} half` : `This is the ${side} half`));
      if (st.marked) buttons.push(h('button', { class: 'link', onClick: name(null) }, 'Forget this half'));
    }
    if (st.actions.includes('mark')) {
      for (const side of ['left', 'right']) if (st.marked !== side) buttons.push(h('button', { onClick: mark(side) }, st.marked ? `No, this is the ${side} half` : `This is the ${side} half`));
      if (st.marked) buttons.push(h('button', { class: 'link', onClick: run(async () => { await app.watch.mark(null); toast('Mark removed.', 'ok'); }) }, 'Remove the mark'));
    }
    el.replaceChildren(...[
      h('p', { class: `conn-head tone-${st.tone}` }, halves(st), h('b', null, st.label)),
      h('ul', { class: 'conn-lines' }, st.lines.map((l) => h('li', { class: 'tone-' + l.tone }, l.text))),
      buttons.length ? h('div', { class: 'btn-row' }, buttons) : null,
    ].filter(Boolean)); // replaceChildren would print a missing piece as the word "null"
  });
}

export function connectionDialog(app) {
  const section = (title, target) => h('section', { class: 'block' }, h('h3', null, title), connectionDetail(app, target));
  const first = app.target === 'vial' ? 'vial' : 'zmk';
  const names = { zmk: app.keyboardName, vial: app.vialTarget.name.replace(/^Keebart /, '') };
  const order = first === 'vial' ? ['vial', 'zmk'] : ['zmk', 'vial'];
  modal({ title: 'What is plugged in', body: h('div', { class: 'conn-dialog' }, order.map((t) => section(names[t], t))) });
}
