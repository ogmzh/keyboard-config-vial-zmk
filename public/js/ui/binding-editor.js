// The "what does this key do" dialog: pick a behavior, then fill in its parameters.

import { h, modal, code } from './dom.js';
import { parseBindings, bindingText } from '../core/keymap.js';
import { splitCells } from '../core/dts.js';
import { MOD_ORDER, MOD_SYMBOL, MOD_TITLE } from '../core/zmk-keys.js';
import { describe, paramLabels } from './describe.js';

// KeyboardEvent.code -> ZMK key name, for "press a key to pick it"
const EVENT_CODES = {
  Minus: 'MINUS', Equal: 'EQUAL', BracketLeft: 'LBKT', BracketRight: 'RBKT', Backslash: 'BSLH', Semicolon: 'SEMI', Quote: 'SQT', Backquote: 'GRAVE',
  Comma: 'COMMA', Period: 'DOT', Slash: 'FSLH', Space: 'SPACE', Enter: 'ENTER', Escape: 'ESC', Backspace: 'BSPC', Tab: 'TAB', CapsLock: 'CAPS',
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', Home: 'HOME', End: 'END', PageUp: 'PG_UP', PageDown: 'PG_DN',
  Insert: 'INS', Delete: 'DEL', PrintScreen: 'PSCRN', ScrollLock: 'SLCK', Pause: 'PAUSE_BREAK', ContextMenu: 'K_APP',
  ShiftLeft: 'LSHIFT', ShiftRight: 'RSHIFT', ControlLeft: 'LCTRL', ControlRight: 'RCTRL', AltLeft: 'LALT', AltRight: 'RALT', MetaLeft: 'LGUI', MetaRight: 'RGUI',
  NumpadEnter: 'KP_ENTER', NumpadAdd: 'KP_PLUS', NumpadSubtract: 'KP_MINUS', NumpadMultiply: 'KP_MULTIPLY', NumpadDivide: 'KP_DIVIDE', NumpadDecimal: 'KP_DOT', NumLock: 'KP_NUM',
};
function codeToZmk(c) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(c))) return m[1];
  if ((m = /^Digit(\d)$/.exec(c))) return 'N' + m[1];
  if ((m = /^F(\d+)$/.exec(c))) return 'F' + m[1];
  if ((m = /^Numpad(\d)$/.exec(c))) return 'KP_N' + m[1];
  return EVENT_CODES[c] || null;
}

const DEFAULTS = { code: 'A', mod: 'LSHIFT', layer: '1', int: '0' };

// Resolves with the new binding, or null if cancelled.
export function editBinding(app, { binding, title = 'Edit key', macro = false, sensor = false, extra = null, note = null }) {
  const { km, zk } = app;
  return new Promise((resolve) => {
    let cur = { behavior: binding ? binding.behavior : 'kp', params: binding ? [...binding.params] : ['A'] };
    let active = 0;
    let filter = '';
    let rawEdited = null;

    const info = () => km.behavior(cur.behavior);
    const behaviors = km.allBehaviors({ macroControls: macro, sensor }).filter((b) => (sensor ? b.sensor || b.compatible?.startsWith('zmk,behavior-sensor') : !b.sensor && !(b.compatible || '').startsWith('zmk,behavior-sensor')));

    const left = h('div', { class: 'be-left' });
    const right = h('div', { class: 'be-right' });
    const preview = h('input', { class: 'be-raw tok', type: 'text', spellcheck: false, 'aria-label': 'Binding as text', onInput: () => { rawEdited = preview.value; } });

    function setBehavior(name) {
      const next = km.behavior(name);
      const prevInfo = info();
      // carry over what still makes sense: the same kind of parameter keeps its value (a key stays that key)
      const pool = (prevInfo.params || []).map((type, i) => ({ type, value: cur.params[i], used: false })).filter((x) => x.value !== undefined);
      const params = (next.params || []).map((type, i) => {
        const same = pool.find((x) => !x.used && x.type === type && (type !== 'command')) ;
        if (same && (prevInfo.params[i] === type || type === 'code' || type === 'layer')) { same.used = true; return same.value; }
        if (type === 'command') return Object.keys(next.commands || {})[0] || '0';
        if (type === 'layer') return String(Math.min(1, km.layerNodes.length - 1));
        return DEFAULTS[type] ?? '0';
      });
      cur = { behavior: name, params };
      active = 0; rawEdited = null;
      draw();
    }

    function setParam(i, value) { cur.params[i] = value; rawEdited = null; drawRight(); drawPreview(); }

    const behaviorList = h('div', { class: 'be-list' });
    left.append(
      h('input', { type: 'search', placeholder: 'Find a behavior', 'aria-label': 'Find a behavior', onInput: (e) => { filter = e.target.value; drawLeft(); } }),
      behaviorList);

    function drawLeft() {
      const q = filter.trim().toLowerCase();
      const list = behaviors.filter((b) => !q || ('&' + b.name).includes(q) || b.title.toLowerCase().includes(q));
      const group = (label, items) => (items.length ? [h('div', { class: 'be-group' }, label), ...items.map((b) => h('button', {
        type: 'button', class: `be-item ${b.name === cur.behavior ? 'on' : ''}`, onClick: () => setBehavior(b.name), title: b.hint || '',
      }, code('&' + b.name), h('span', null, b.title)))] : []);
      behaviorList.replaceChildren(
        ...group('In this keymap', list.filter((b) => b.custom)),
        ...group('Built in', list.filter((b) => !b.custom && !b.macro)),
        ...group('Macro controls', list.filter((b) => b.macro && !b.custom)));
      if (!list.length) behaviorList.append(h('p', { class: 'muted' }, 'No behavior matches that.'));
    }

    function drawRight() {
      const inf = info();
      if (!inf.params) {
        right.replaceChildren(h('p', { class: 'muted' }, `&${cur.behavior} is not a behavior this app knows. Edit it as text below.`));
        return;
      }
      if (!inf.params.length) {
        right.replaceChildren(h('p', { class: 'be-empty' }, h('strong', null, inf.title), h('br'), inf.hint || 'This behavior takes no parameters.'));
        return;
      }
      const labels = paramLabels(inf);
      if (active >= inf.params.length) active = 0;
      const chips = h('div', { class: 'be-chips', role: 'tablist' }, inf.params.map((type, i) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(i === active), class: `be-chip ${i === active ? 'on' : ''}`, onClick: () => { active = i; drawRight(); },
      }, h('small', null, labels[i]), h('span', null, paramSummary(type, cur.params[i], inf)))));
      right.replaceChildren(inf.params.length > 1 ? chips : h('div', { class: 'be-single' }, labels[0]), paramEditor(inf.params[active], active, inf));
    }

    function paramSummary(type, value, inf) {
      if (type === 'code' || type === 'mod') return zk.label(value || '') || '—';
      if (type === 'layer') { const n = km.resolveLayer(value); return n !== null && km.layers[n] ? `${n} ${km.layers[n].label}` : String(value); }
      if (type === 'command') { const c = (inf.commands || {})[String(value).replace(/\(.*$/, '')]; return c ? c.title : String(value); }
      return String(value ?? '');
    }

    function paramEditor(type, i, inf) {
      const value = cur.params[i];
      if (type === 'code' || type === 'mod') return keyPicker(zk, value || '', (v) => setParam(i, v), type === 'mod');
      if (type === 'layer') {
        return h('div', { class: 'be-layers' }, km.layers.map((l) => h('button', {
          type: 'button', class: `be-layer ${km.resolveLayer(value) === l.index ? 'on' : ''}`, onClick: () => setParam(i, String(l.index)),
        }, h('b', null, l.index), ' ', l.label)));
      }
      if (type === 'command') {
        const cmds = inf.commands || {};
        const fn = /^(\w+)\((.*)\)$/.exec(value || '');
        const curCmd = fn ? fn[1] : value;
        const extra = (cmds[curCmd] || {}).extra || [];
        const pick = (name) => {
          const ex = (cmds[name] || {}).extra || [];
          if (ex[0] === 'fn3') { cur.params = [`${name}(0,100,50)`]; } else { cur.params = ex.length ? [name, cur.params[1] && /^\d+$/.test(cur.params[1]) ? cur.params[1] : '0'] : [name]; }
          rawEdited = null; drawRight(); drawPreview();
        };
        const extras = [];
        if (extra[0] === 'int') extras.push(h('label', { class: 'field inline' }, h('span', null, 'Number'), h('input', { type: 'number', min: 0, value: cur.params[1] ?? '0', onInput: (e) => { cur.params[1] = e.target.value || '0'; rawEdited = null; drawPreview(); } })));
        if (extra[0] === 'fn3') {
          const vals = (fn ? fn[2] : '0,100,50').split(',').map((s) => s.trim());
          ['Hue 0–360', 'Saturation 0–100', 'Brightness 0–100'].forEach((lab, k) => extras.push(h('label', { class: 'field inline' }, h('span', null, lab), h('input', {
            type: 'number', min: 0, value: vals[k] ?? '0', onInput: (e) => { vals[k] = e.target.value || '0'; cur.params = [`${curCmd}(${vals.join(',')})`]; rawEdited = null; drawPreview(); },
          }))));
        }
        return h('div', null, h('div', { class: 'be-cmds' }, Object.entries(cmds).map(([name, c]) => h('button', { type: 'button', class: `be-layer ${name === curCmd ? 'on' : ''}`, onClick: () => pick(name) }, c.title, ' ', code(name)))), extras);
      }
      return h('label', { class: 'field inline' }, h('span', null, 'Value'), h('input', { type: 'number', value: value ?? '0', onInput: (e) => { cur.params[i] = e.target.value || '0'; rawEdited = null; drawPreview(); } }));
    }

    function drawPreview() { if (rawEdited === null) preview.value = bindingText(cur); }
    function draw() { drawLeft(); drawRight(); drawPreview(); }

    function result() {
      if (rawEdited !== null && rawEdited.trim() !== bindingText(cur)) {
        const parsed = parseBindings(splitCells(rawEdited.replace(/[<>;]/g, ' ')));
        if (parsed.length !== 1) { preview.classList.add('bad'); preview.focus(); return undefined; }
        return parsed[0];
      }
      const inf = info();
      return { behavior: cur.behavior, params: inf.params ? cur.params.slice(0, Math.max(inf.params.length, inf.commands ? cur.params.length : 0)) : cur.params };
    }

    const m = modal({
      title,
      wide: true,
      cls: 'binding-editor',
      body: h('div', null, note ? h('p', { class: 'be-note' }, note) : null, extra, h('div', { class: 'be-cols' }, left, right)),
      footer: [
        h('div', { class: 'be-preview' }, h('span', { class: 'muted' }, 'In the keymap file'), preview),
        h('button', { onClick: () => m.close(null) }, 'Cancel'),
        h('button', { class: 'primary', onClick: () => { const r = result(); if (r) m.close(r); } }, 'Apply'),
      ],
      onClose: (r) => resolve(r || null),
    });
    m.dialog.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { const r = result(); if (r) m.close(r); } });
    draw();
  });
}

// Search box, modifier toggles and a result list for one key parameter.
export function keyPicker(zk, value, onChange, modOnly = false) {
  let parsed = zk.parse(value);
  let query = '';
  let capturing = false;
  const emit = () => onChange(zk.build(parsed.name, parsed.mods));
  const current = h('div', { class: 'kp-current' });
  const mods = h('div', { class: 'kp-mods', role: 'group', 'aria-label': 'Modifiers sent with the key' });
  const results = h('div', { class: 'kp-results', role: 'listbox' });
  const input = h('input', { type: 'search', placeholder: modOnly ? 'Find a modifier' : 'Find a key: a, enter, volume, f5…', 'aria-label': 'Find a key', onInput: (e) => { query = e.target.value; drawResults(); } });
  const stopCapture = () => { capturing = false; capture.textContent = 'Press a key to pick it'; capture.classList.remove('on'); };
  const grab = h('input', { class: 'kp-grab', 'aria-label': 'Press a key', onKeydown: (e) => {
    if (!capturing) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopCapture(); return; }
    const name = codeToZmk(e.code);
    if (name && zk.get(name)) { parsed = { ...parsed, name, entry: zk.get(name) }; stopCapture(); emit(); draw(); }
  }, onBlur: stopCapture });
  const capture = h('button', { type: 'button', title: 'Then press the key you want on your keyboard', onClick: () => {
    if (capturing) { stopCapture(); return; }
    capturing = true; capture.textContent = 'Press a key…'; capture.classList.add('on'); grab.focus();
  } }, 'Press a key to pick it');
  const root = h('div', { class: 'kp' }, current, mods, h('div', { class: 'kp-search' }, input, capture, grab), results);

  function drawResults() {
    // with nothing typed: plain keys first, then media keys, then system keys
    let list = zk.search(query, 500);
    if (!query.trim()) list = [...list].sort((a, b) => (a.page === 7 ? 0 : a.page === 12 ? 1 : 2) - (b.page === 7 ? 0 : b.page === 12 ? 1 : 2));
    list = list.filter((e) => !modOnly || query || (e.page === 7 && e.id >= 224 && e.id <= 231)).slice(0, 96);
    results.replaceChildren(...list.map((e) => {
      const dep = new Set(e.deprecated || []);
      const names = e.names.filter((x) => !dep.has(x));
      const short = names.reduce((a, b2) => (b2.length < a.length ? b2 : a), names[0] || e.names[0]);
      return h('button', {
        type: 'button', role: 'option', class: `kp-item ${parsed.entry === e ? 'on' : ''}`, 'aria-selected': String(parsed.entry === e), title: e.names.join(', '),
        onClick: () => { parsed = { ...parsed, name: parsed.entry === e ? parsed.name : short, entry: e }; emit(); draw(); },
      }, h('span', { class: 'kp-cap' }, e.label), h('span', { class: 'kp-desc' }, e.desc.replace(/^Keyboard /, '')), code(short));
    }));
    if (!list.length) results.append(h('p', { class: 'muted' }, 'No key matches that.'));
  }

  function draw() {
    const full = zk.build(parsed.name, parsed.mods);
    current.replaceChildren(
      h('span', { class: 'kp-label' }, zk.label(full)),
      h('span', null, parsed.entry ? zk.describe(full) : h('span', { class: 'warn-text' }, `"${parsed.name}" is not a known key name`)));
    mods.replaceChildren(h('span', { class: 'muted' }, 'With'),
      ...MOD_ORDER.map((m) => h('button', {
        type: 'button', class: `kp-mod ${parsed.mods.includes(m) ? 'on' : ''}`, title: MOD_TITLE[m], 'aria-pressed': String(parsed.mods.includes(m)),
        onClick: () => { parsed.mods = parsed.mods.includes(m) ? parsed.mods.filter((x) => x !== m) : [...parsed.mods, m]; emit(); draw(); },
      }, h('small', null, m[0]), MOD_SYMBOL[m])));
    drawResults();
  }
  draw();
  return root;
}

// Small read-only chip showing a binding like a keycap, used in lists.
export function bindingChip(app, binding, onClick, title) {
  const d = describe(binding, app.km, app.zk);
  return h('button', { type: 'button', class: `chip k-${d.kind}`, title: title || d.title, onClick },
    h('span', { class: 'chip-main' }, d.main || (d.kind === 'none' ? 'none' : '?')), d.sub ? h('small', null, d.sub) : null, code(bindingText(binding)));
}
