// Starts the app and draws the frame: top bar, tabs, the active view and the side panel.

import { App } from './app.js';
import { h, anyModalOpen, toast } from './ui/dom.js';
import { keysView, combosView, macrosView, behaviorsView, conditionalView } from './ui/views.js';
import { zmkPanel, vialPanel, sourceDialog } from './ui/panels.js';
import { ConnectionWatch } from './core/watch.js';
import { connectionBadge, refreshConnection } from './ui/connection.js';

const root = document.getElementById('app');
const app = new App(root);
window.keymapBridge = app; // handy in the browser console
// what is plugged in right now, and which half; the pieces of the page that show it redraw themselves
app.watch = new ConnectionWatch({ target: () => app.vialTarget, onChange: refreshConnection });

const VIEWS = { keys: keysView, combos: combosView, macros: macrosView, behaviors: behaviorsView, conditional: conditionalView };

function topbar() {
  const src = app.source;
  const where = src.kind === 'repo' ? src.file : src.kind === 'bundled' ? `${src.file} (bundled copy)` : src.file;
  const target = (id, name, detail) => h('button', { role: 'radio', 'aria-checked': String(app.target === id), class: `target ${id} ${app.target === id ? 'on' : ''}`, onClick: () => app.setTarget(id) },
    h('span', { class: 'target-name' }, name), h('span', { class: 'target-detail' }, detail));
  return h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, h('span', { class: 'mark', 'aria-hidden': 'true' }, h('i'), h('i')), 'Keymap Bridge'),
    h('button', { class: 'source-btn', title: 'Choose another keymap or folder', onClick: () => sourceDialog(app) }, h('span', { class: 'tok' }, where), h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾')),
    h('div', { class: 'targets', role: 'radiogroup', 'aria-label': 'Keyboard to work on' },
      target('zmk', app.keyboardName, 'ZMK, wireless'),
      target('vial', app.vialTarget.name.replace(/^Keebart /, ''), 'Vial, wired')),
    connectionBadge(app),
    h('div', { class: 'top-actions' },
      h('span', { class: `state ${app.dirty ? 'dirty' : ''}` }, app.dirty ? 'Unsaved changes' : ''),
      h('button', { disabled: app.at === 0, title: 'Undo (Cmd+Z)', onClick: () => app.step(-1) }, 'Undo'),
      h('button', { disabled: app.at >= app.history.length - 1, title: 'Redo (Shift+Cmd+Z)', onClick: () => app.step(1) }, 'Redo'),
      app.source.kind === 'repo' ? h('button', { class: 'primary', disabled: !app.dirty && !app.vialDirty, title: 'Save (Cmd+S)', onClick: () => app.save() }, 'Save') : null));
}

function tabs() {
  const km = app.km;
  const items = [['keys', 'Keys', km.layers.length + ' layers'], ['combos', 'Combos', km.combos.length], ['macros', 'Macros', km.macros.length], ['behaviors', 'Behaviors', km.behaviors.length], ['conditional', 'Conditional layers', km.conditionalLayers.length]];
  return h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Parts of the keymap' },
    items.map(([id, label, count]) => h('button', { role: 'tab', 'aria-selected': String(app.tab === id), class: app.tab === id ? 'on' : '', onClick: () => { app.tab = id; app.render(); } }, label, h('span', { class: 'count' }, count))));
}

function render() {
  if (!app.km) return;
  const keep = [...root.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll, el.scrollTop]);
  document.documentElement.dataset.target = app.target;
  const main = h('main', { class: 'main', dataset: { scroll: 'main:' + app.tab } }, VIEWS[app.tab](app));
  const side = app.target === 'vial' ? vialPanel(app) : zmkPanel(app);
  side.dataset.scroll = 'side:' + app.target;
  root.replaceChildren(topbar(), tabs(), h('div', { class: 'work' }, main, side));
  for (const [key, top] of keep) { const el = root.querySelector(`[data-scroll="${key}"]`); if (el) el.scrollTop = top; }
  document.title = `${app.dirty ? '• ' : ''}${app.source.file.split('/').pop()} – Keymap Bridge`;
}
app.onRender = render;

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ''));
  if (e.key.toLowerCase() === 's') { e.preventDefault(); if (!anyModalOpen()) app.save(); }
  else if (e.key.toLowerCase() === 'z' && !typing && !anyModalOpen()) { e.preventDefault(); app.step(e.shiftKey ? 1 : -1); }
});
window.addEventListener('beforeunload', (e) => { if (app.dirty) { e.preventDefault(); e.returnValue = ''; } });

app.start().then(() => app.watch.start()).catch((e) => {
  console.error(e);
  root.replaceChildren(h('div', { class: 'boot' }, h('h1', null, 'Keymap Bridge could not start'), h('p', null, e.message), h('p', null, 'Start it with "npm start" in the keymap-bridge folder and open http://localhost:4777')));
  toast(e.message, 'error');
});
