// The five editing views: keys, combos, macros, behaviors, conditional layers.

import { h, modal, code, confirmDialog, promptDialog, toast, field } from './dom.js';
import { keyboardView } from './keyboard.js';
import { describe } from './describe.js';
import { editBinding, bindingChip } from './binding-editor.js';
import { bindingText } from '../core/keymap.js';
import { BEHAVIOR_TYPES, MOD_FLAGS } from '../core/behaviors.js';

const STATUS_TEXT = { ok: 'Carries over exactly', approx: 'Carries over with a difference', unsupported: 'No equivalent on this keyboard', override: 'Set by hand for this keyboard' };

function capsFor(app, layerIndex) {
  const { km, zk } = app;
  const layer = km.layers[layerIndex];
  const n = km.keyCount;
  if (app.target === 'vial') {
    const row = app.translation.keys[layerIndex] || [];
    return Array.from({ length: n }, (_, i) => {
      const k = row[i];
      if (!k) return { kind: 'none', main: '' };
      let lg = app.qmk.legend(k.code);
      let kind = k.code === 1 ? 'trans' : k.code === 0 ? 'none' : k.code < 0x5000 ? 'alpha' : 'mod';
      let more = '';
      const tr = app.translation;
      if (k.code >= 0x7700 && k.code <= 0x77FF && tr.macroNames[k.code - 0x7700]) { lg = { top: k.name, main: tr.macroNames[k.code - 0x7700].replace(/_/g, ' ') }; kind = 'macro'; more = `\nMacro: ${tr.macros[k.code - 0x7700].map((a) => a.join(' ')).join(', ')}`; }
      if (k.code >= 0x5700 && k.code <= 0x57FF && tr.tapDance[k.code - 0x5700]) { const e = tr.tapDance[k.code - 0x5700]; lg = { top: k.name, main: app.qmk.legend(e[0]).main, sub: 'hold ' + app.qmk.legend(e[1]).main }; kind = 'macro'; more = `\nTap dance: tap ${e[0]}, hold ${e[1]}, double tap ${e[2]}, ${e[4]} ms`; }
      return { tag: lg.top, main: k.code === 1 ? '▽' : lg.main, sub: lg.sub, kind, status: k.status, title: `${k.name}\n${STATUS_TEXT[k.status]}${k.note ? ': ' + k.note : ''}${more}\nIn the keymap: ${k.source}` };
    });
  }
  return Array.from({ length: n }, (_, i) => describe(layer.bindings[i], km, zk));
}

// ---------- keys ----------
export function keysView(app) {
  const { km } = app;
  const layers = km.layers;
  const layer = layers[app.layer];
  const layout = km.layout;

  const strip = h('div', { class: 'layers', role: 'tablist', 'aria-label': 'Layers' },
    layers.map((l) => h('button', { role: 'tab', 'aria-selected': String(l.index === app.layer), class: `layer-tab ${l.index === app.layer ? 'on' : ''}`, onClick: () => { app.layer = l.index; app.render(); } }, h('b', null, l.index), l.label)),
    h('button', { class: 'layer-add', title: 'Add a layer', onClick: async () => {
      const name = await promptDialog('Add a layer', { label: 'Name shown on the keyboard display', placeholder: 'Nav', okLabel: 'Add layer' });
      if (name === null) return;
      app.commit((k) => { app.layer = k.addLayer(name.trim() || undefined); });
    } }, '+ Layer'));

  const tools = h('div', { class: 'layer-tools' },
    h('button', { title: 'Rename this layer', onClick: async () => {
      const name = await promptDialog(`Rename layer ${layer.index}`, { value: layer.label, okLabel: 'Rename' });
      if (name !== null) app.commit((k) => k.setLayerLabel(app.layer, name.trim()));
    } }, 'Rename'),
    h('button', { disabled: app.layer === 0, title: 'Move this layer earlier', onClick: () => app.commit((k) => { k.moveLayer(app.layer, app.layer - 1); app.layer--; }) }, 'Move up'),
    h('button', { disabled: app.layer === layers.length - 1, title: 'Move this layer later', onClick: () => app.commit((k) => { k.moveLayer(app.layer, app.layer + 1); app.layer++; }) }, 'Move down'),
    h('button', { disabled: layers.length < 2, class: 'quiet-danger', onClick: async () => {
      if (await confirmDialog(`Delete layer ${layer.index} "${layer.label}"?`, 'Delete layer', { danger: true, detail: 'Keys that switch to this layer become "none". Higher layers move down by one.' })) app.commit((k) => k.removeLayer(app.layer));
    } }, 'Delete'));

  let board;
  if (layout) {
    board = keyboardView({ layout, caps: capsFor(app, app.layer), label: `Layer ${layer.index} ${layer.label}`, onKey: (pos) => openKey(app, app.layer, pos) });
  } else {
    board = h('div', { class: 'keylist' }, layer.bindings.map((b, i) => bindingChip(app, b, () => openKey(app, app.layer, i), `Key ${i}`)));
  }

  return h('section', { class: 'keys-view' },
    h('div', { class: 'layer-bar' }, strip, app.target === 'zmk' ? tools : null),
    app.target === 'vial' ? h('p', { class: 'view-note' }, `This is what the ${app.vialTarget.name} will do. Click a key to change it, or to give it a different job on this keyboard only.`) : null,
    h('div', { class: `mat ${app.target}` }, board),
    encodersRow(app, layer),
    app.target === 'vial' ? statusLegend() : null);
}

function statusLegend() {
  return h('ul', { class: 'legend' },
    h('li', null, h('span', { class: 'dot st-approx' }), 'Works, with a difference'),
    h('li', null, h('span', { class: 'dot st-unsupported' }), 'No equivalent, key does nothing'),
    h('li', null, h('span', { class: 'dot st-override' }), 'Set by hand for this keyboard'));
}

function encodersRow(app, layer) {
  const { km } = app;
  const sensors = km.sensors || [];
  if (!sensors.length) return null;
  const names = sensors.map((s, i) => (s.name || s.identifier || `encoder ${i + 1}`).replace(/_/g, ' '));
  if (app.target === 'vial') {
    const enc = app.translation.encoders[layer.index] || [];
    return h('div', { class: 'encoders' }, h('h3', null, 'Encoders'),
      enc.map((pair, i) => h('div', { class: 'enc', title: 'Counter-clockwise / clockwise' }, h('small', null, names[i] || `encoder ${i + 1}`), code(`↺ ${pair[0].name}`), code(`↻ ${pair[1].name}`))));
  }
  const sb = layer.sensorBindings;
  const edit = async (i) => {
    const cur = (sb && sb[i]) || { behavior: 'inc_dec_kp', params: ['C_VOL_UP', 'C_VOL_DN'] };
    const next = await editBinding(app, { binding: cur, title: `${names[i]} on layer ${layer.label}`, sensor: true, note: 'The first key is sent when you turn clockwise, the second when you turn counter-clockwise.' });
    if (!next) return;
    app.commit((k) => {
      const list = k.layers[app.layer].sensorBindings || sensors.map(() => ({ behavior: 'inc_dec_kp', params: ['C_VOL_UP', 'C_VOL_DN'] }));
      list[i] = next; k.setSensorBindings(app.layer, list);
    });
  };
  return h('div', { class: 'encoders' }, h('h3', null, 'Encoders'),
    sb
      ? [sensors.map((s, i) => h('button', { class: 'enc', onClick: () => edit(i), title: sb[i] ? describe(sb[i], km, app.zk).title : '' }, h('small', null, names[i]), sb[i] ? code(bindingText(sb[i])) : 'not set')),
        h('button', { class: 'link', onClick: () => app.commit((k) => k.setSensorBindings(app.layer, null)) }, 'Use the layer below instead')]
      : [h('span', { class: 'muted' }, 'This layer uses the encoder actions of the layer below.'), h('button', { class: 'link', onClick: () => edit(0) }, 'Set them for this layer')]);
}

async function openKey(app, layerIndex, pos) {
  const { km } = app;
  const layer = km.layers[layerIndex];
  const cur = layer.bindings[pos] || { behavior: 'trans', params: [] };
  let extra = null; let ovInput = null; let ovCheck = null;
  const key = `${layerIndex}:${pos}`;
  if (app.target === 'vial') {
    const k = app.translation.keys[layerIndex][pos];
    const has = key in app.vial.overrides;
    ovInput = h('input', { type: 'text', class: 'tok', spellcheck: false, placeholder: 'QK_BOOT, KC_F13, LCTL(KC_C)…', value: app.vial.overrides[key] || '', disabled: !has, 'aria-label': 'Vial keycode' });
    ovCheck = h('input', { type: 'checkbox', checked: has, onChange: () => { ovInput.disabled = !ovCheck.checked; if (ovCheck.checked) ovInput.focus(); } });
    extra = h('div', { class: `vial-box st-${k.status}` },
      h('div', null, `On the ${app.vialTarget.name} this key sends `, code(k.name), '. ', h('span', { class: 'st-text' }, STATUS_TEXT[k.status] + (k.note ? ': ' + k.note : '.'))),
      h('label', { class: 'check' }, ovCheck, 'Use a different Vial keycode on this keyboard only'), ovInput);
  }
  const next = await editBinding(app, { binding: cur, title: `Layer ${layer.label}, key ${pos}`, extra });
  if (!next) return;
  if (ovCheck) {
    const overrides = { ...app.vial.overrides };
    if (ovCheck.checked && ovInput.value.trim()) {
      try { app.qmk.decode(ovInput.value.trim()); overrides[key] = ovInput.value.trim(); }
      catch (e) { toast(`Vial keycode not saved: ${e.message}`, 'error'); }
    } else delete overrides[key];
    if (JSON.stringify(overrides) !== JSON.stringify(app.vial.overrides)) { app.vial = { ...app.vial, overrides }; localStorage.setItem('kb.vial.' + app.source.file, JSON.stringify(app.vial)); }
  }
  app.commit((k) => k.setBinding(layerIndex, pos, next));
}

// ---------- shared small widgets ----------
function miniBoard(app, selected, onClick, title) {
  const layout = app.km.layout;
  if (!layout) return h('button', { class: 'chip', onClick }, [...selected].join(' ') || 'none');
  const base = app.km.layers[0];
  const caps = layout.map((_, i) => ({ kind: selected.has(i) ? 'alpha' : 'ghost', selected: selected.has(i), main: selected.has(i) ? describe(base.bindings[i], app.km, app.zk).main : '' }));
  return h('button', { class: 'mini', title, onClick }, keyboardView({ layout, caps, interactive: false, maxUnit: 15, minUnit: 9 }));
}

function pickPositions(app, initial, title, hint) {
  return new Promise((resolve) => {
    const sel = new Set(initial);
    const base = app.km.layers[0];
    const holder = h('div');
    const draw = () => {
      const caps = app.km.layout.map((_, i) => ({ ...describe(base.bindings[i], app.km, app.zk), selected: sel.has(i), dim: !sel.has(i) }));
      holder.replaceChildren(keyboardView({ layout: app.km.layout, caps, onKey: (i) => { if (sel.has(i)) sel.delete(i); else sel.add(i); draw(); }, maxUnit: 54 }),
        h('p', { class: 'muted' }, sel.size ? `Positions: ${[...sel].join(', ')}` : 'No keys chosen.'));
    };
    draw();
    const m = modal({ title, wide: true, body: h('div', null, hint ? h('p', { class: 'muted' }, hint) : null, h('div', { class: 'mat zmk' }, holder)),
      footer: [h('button', { onClick: () => m.close(null) }, 'Cancel'), h('button', { class: 'primary', onClick: () => m.close([...sel]) }, 'Use these keys')], onClose: (r) => resolve(r || null) });
  });
}

const numInput = (value, onChange, placeholder = 'default') => h('input', { type: 'number', min: 0, class: 'num', value: value ?? '', placeholder, onChange: (e) => onChange(e.target.value === '' ? undefined : Number(e.target.value)) });

function layerToggles(app, selectedTokens, onChange, emptyMeans) {
  const sel = new Set(selectedTokens.map((t) => app.km.resolveLayer(t)).filter((n) => n !== null));
  return h('div', { class: 'toggles' },
    app.km.layers.map((l) => h('button', { type: 'button', class: `toggle ${sel.has(l.index) ? 'on' : ''}`, 'aria-pressed': String(sel.has(l.index)), onClick: () => { if (sel.has(l.index)) sel.delete(l.index); else sel.add(l.index); onChange([...sel].sort((a, b) => a - b).map(String)); } }, `${l.index} ${l.label}`)),
    !sel.size && emptyMeans ? h('span', { class: 'muted' }, emptyMeans) : null);
}

function issuesFor(app, test) {
  if (app.target !== 'vial') return null;
  const list = app.translation.issues.filter(test);
  if (!list.length) return null;
  return h('ul', { class: 'row-issues' }, list.map((i) => h('li', { class: 'lv-' + i.level }, i.message)));
}

function emptyState(text, button) { return h('div', { class: 'empty' }, h('p', null, text), button); }

// ---------- combos ----------
export function combosView(app) {
  const { km } = app;
  const combos = km.combos;
  const add = h('button', { class: 'primary', onClick: () => app.commit((k) => k.addCombo()) }, 'Add a combo');
  if (!combos.length) return h('section', { class: 'list-view' }, emptyState('A combo fires when you press several keys at the same time. This keymap has none yet.', add));
  const tr = app.target === 'vial' ? app.translation : null;
  return h('section', { class: 'list-view' },
    h('div', { class: 'view-head' }, h('h2', null, 'Combos'), add),
    combos.map((c, idx) => {
      const up = (patch) => app.commit((k) => k.updateCombo(k.combos[idx].node, patch));
      const vi = tr ? tr.comboNames.indexOf(c.name) : -1;
      return h('article', { class: 'row combo' },
        h('div', { class: 'row-main' },
          h('input', { class: 'name tok', value: c.name, 'aria-label': 'Combo name', onChange: (e) => { const v = e.target.value.trim(); if (/^[A-Za-z_][\w]*$/.test(v)) up({ name: v }); else { toast('Use letters, digits and underscores.', 'error'); e.target.value = c.name; } } }),
          miniBoard(app, new Set(c.keyPositions), async () => { const r = await pickPositions(app, c.keyPositions, `Keys for combo "${c.name}"`, 'Click the keys that are pressed together. Legends show the first layer.'); if (r && r.length) up({ keyPositions: r }); }, 'Change the keys'),
          h('span', { class: 'arrow', 'aria-hidden': 'true' }, 'sends'),
          bindingChip(app, c.bindings[0] || { behavior: 'none', params: [] }, async () => { const r = await editBinding(app, { binding: c.bindings[0], title: `Combo "${c.name}" sends` }); if (r) up({ bindings: [r] }); }),
          h('button', { class: 'icon-btn quiet-danger', title: 'Delete this combo', 'aria-label': `Delete combo ${c.name}`, onClick: async () => { if (await confirmDialog(`Delete combo "${c.name}"?`, 'Delete', { danger: true })) app.commit((k) => k.removeCombo(k.combos[idx].node)); } }, '✕')),
        h('div', { class: 'row-opts' },
          field('On layers', layerToggles(app, c.layers, (layers) => up({ layers }), 'all layers')),
          field('Timeout (ms)', numInput(c.timeoutMs, (v) => up({ timeoutMs: v }), '50')),
          field('Needs idle before (ms)', numInput(c.requirePriorIdleMs, (v) => up({ requirePriorIdleMs: v }), 'off')),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.slowRelease, onChange: (e) => up({ slowRelease: e.target.checked }) }), 'Release only when all keys are up')),
        tr ? h('div', { class: 'row-vial' }, vi >= 0 ? ['Vial combo: ', code(tr.combos[vi].slice(0, 4).filter((x) => x !== 'KC_NO').join(' + ')), ' sends ', code(tr.combos[vi][4])] : h('span', { class: 'st-text st-unsupported' }, 'Not on the Vial keyboard')) : null,
        issuesFor(app, (i) => i.where.combo === c.name));
    }));
}

// ---------- conditional layers ----------
export function conditionalView(app) {
  const { km } = app;
  const rows = km.conditionalLayers;
  const add = h('button', { class: 'primary', onClick: () => app.commit((k) => k.addConditionalLayer()) }, 'Add a conditional layer');
  const vialNote = app.target === 'vial' && rows.length ? h('p', { class: 'row-issues' }, h('span', { class: 'lv-warn' }, 'Conditional layers are not sent to the Vial keyboard. Vial has its own tri-layer keys (FN_MO13, FN_MO23); a combo that holds a layer does a similar job.')) : null;
  if (!rows.length) return h('section', { class: 'list-view' }, emptyState('A conditional layer turns on by itself while a set of other layers is active, for example layer 3 while layers 1 and 2 are both held.', add));
  return h('section', { class: 'list-view' },
    h('div', { class: 'view-head' }, h('h2', null, 'Conditional layers'), add), vialNote,
    rows.map((r, idx) => {
      const up = (patch) => app.commit((k) => k.updateConditionalLayer(k.conditionalLayers[idx].node, patch));
      return h('article', { class: 'row' }, h('div', { class: 'row-opts' },
        field('While these layers are active', layerToggles(app, r.ifLayers, (ifLayers) => { if (ifLayers.length) up({ ifLayers }); })),
        field('Turn on', h('select', { onChange: (e) => up({ thenLayer: e.target.value }) }, km.layers.map((l) => h('option', { value: String(l.index), selected: km.resolveLayer(r.thenLayer) === l.index }, `${l.index} ${l.label}`)))),
        h('button', { class: 'icon-btn quiet-danger', title: 'Delete', 'aria-label': 'Delete this conditional layer', onClick: () => app.commit((k) => k.removeConditionalLayer(k.conditionalLayers[idx].node)) }, '✕')));
    }));
}

// ---------- behaviors and macros ----------
function stepsEditor(app, steps, onChange, { macro = false, fixed = 0, labels } = {}) {
  const editStep = async (i) => {
    const m2 = await editBinding(app, { binding: steps[i], title: labels && labels[i] ? labels[i] : `Step ${i + 1}`, macro });
    if (m2) { const next = [...steps]; next[i] = m2; onChange(next); }
  };
  return h('div', { class: 'steps' },
    steps.map((s, i) => h('span', { class: 'step' },
      labels && labels[i] ? h('small', { class: 'muted' }, labels[i]) : null,
      bindingChip(app, s, () => editStep(i)),
      fixed ? null : h('span', { class: 'step-tools' },
        h('button', { class: 'icon-btn', title: 'Move earlier', 'aria-label': 'Move step earlier', disabled: i === 0, onClick: () => { const n = [...steps]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; onChange(n); } }, '‹'),
        h('button', { class: 'icon-btn', title: 'Move later', 'aria-label': 'Move step later', disabled: i === steps.length - 1, onClick: () => { const n = [...steps]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; onChange(n); } }, '›'),
        h('button', { class: 'icon-btn quiet-danger', title: 'Remove', 'aria-label': 'Remove step', onClick: () => onChange(steps.filter((_, k) => k !== i)) }, '✕')))),
    fixed ? null : h('button', { class: 'step-add', onClick: async () => { const r = await editBinding(app, { binding: { behavior: 'kp', params: ['A'] }, title: 'Add a step', macro }); if (r) onChange([...steps, r]); } }, '+ Step'));
}

function fieldEditor(app, name, f, onSet) {
  const node = app.km.behavior(name).node;
  const value = app.km.getField(node, f);
  const label = f.label || f.name;
  switch (f.type) {
    case 'bool': return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!value, onChange: (e) => onSet(f, e.target.checked) }), label);
    case 'int': return field(label, numInput(value, (v) => onSet(f, v), f.default !== undefined ? String(f.default) : 'default'));
    case 'enum': return field(label, h('select', { onChange: (e) => onSet(f, e.target.value) }, f.options.map((o) => h('option', { value: o, selected: (value || f.default) === o }, o))));
    case 'refs': {
      const options = app.km.allBehaviors().filter((b) => (b.params || []).length === 1 || b.name === 'kp');
      return h('div', { class: 'refs' }, Array.from({ length: f.count }, (_, i) => field(f.labels[i], h('select', { onChange: (e) => { const next = [...value]; while (next.length < f.count) next.push('kp'); next[i] = e.target.value; onSet(f, next); } },
        options.map((b) => h('option', { value: b.name, selected: value[i] === b.name }, `&${b.name}  ${b.title}`))))));
    }
    case 'bindings': return field(label, stepsEditor(app, value, (next) => onSet(f, next), { macro: !!(BEHAVIOR_TYPES[app.km.behavior(name).compatible] || {}).macro, fixed: f.count || 0, labels: f.labels }));
    case 'positions': return field(label, h('div', { class: 'pos-field' },
      miniBoard(app, new Set(value), async () => { const r = await pickPositions(app, value, label, 'With these set, a hold only wins if the next key pressed is one of them.'); if (r) onSet(f, r); }, 'Change positions'),
      value.length ? h('button', { class: 'link', onClick: () => onSet(f, []) }, 'Clear') : h('span', { class: 'muted' }, 'any key')));
    case 'mods': return field(label, h('div', { class: 'toggles' }, MOD_FLAGS.map((m) => h('button', { type: 'button', class: `toggle ${value.includes(m) ? 'on' : ''}`, 'aria-pressed': String(value.includes(m)), onClick: () => onSet(f, value.includes(m) ? value.filter((x) => x !== m) : [...value, m]) }, m.replace('MOD_', '')))));
    case 'codes': return field(label, h('input', { type: 'text', class: 'tok', value: value.join(' '), placeholder: 'UNDERSCORE BACKSPACE DELETE', onChange: (e) => onSet(f, e.target.value.trim().split(/\s+/).filter(Boolean)) }));
    default: return null;
  }
}

function behaviorCard(app, b) {
  const type = BEHAVIOR_TYPES[b.compatible];
  const used = app.km.usageCount(b.name);
  const set = (f, v) => app.commit((k) => k.setField(k.behavior(b.name).node, f, v));
  let vial = null;
  if (app.target === 'vial' && b.macro) {
    const i = app.translation.macroNames.indexOf(b.name);
    vial = h('div', { class: 'row-vial' }, i >= 0 ? [`Vial macro M${i}: `, code(app.translation.macros[i].map((a) => (a[0] === 'delay' ? `wait ${a[1]}ms` : `${a[0]} ${a.slice(1).join(' ')}`)).join(', ') || 'empty')] : h('span', { class: 'st-text st-unsupported' }, 'Not on the Vial keyboard'));
  }
  return h('article', { class: 'row behavior' },
    h('div', { class: 'row-main' },
      h('span', { class: 'amp' }, '&'),
      h('input', { class: 'name tok', value: b.name, 'aria-label': 'Name', onChange: (e) => { const v = e.target.value.trim(); app.commit((k) => k.renameBehavior(k.behavior(b.name).node, v)); } }),
      h('span', { class: 'type' }, type ? type.title : b.compatible),
      h('span', { class: 'muted' }, used ? `used ${used} time${used > 1 ? 's' : ''}` : 'not used'),
      h('button', { class: 'icon-btn quiet-danger', title: 'Delete', 'aria-label': `Delete ${b.name}`, onClick: async () => { if (await confirmDialog(`Delete &${b.name}?`, 'Delete', { danger: true, detail: used ? `It is used ${used} time${used > 1 ? 's' : ''}; those keys become "none".` : undefined })) app.commit((k) => k.removeBehavior(k.behavior(b.name).node)); } }, '✕')),
    type ? h('div', { class: 'row-opts' }, type.fields.map((f) => fieldEditor(app, b.name, f, set))) : h('p', { class: 'muted' }, 'This behavior type has no form here. Edit it in the keymap file.'),
    vial,
    issuesFor(app, (i) => i.where.macro === b.name));
}

export function macrosView(app) {
  const macros = app.km.macros;
  const add = h('button', { class: 'primary', onClick: async () => { const name = await promptDialog('Add a macro', { label: 'Name (used as &name on keys)', placeholder: 'my_macro', okLabel: 'Add macro' }); if (name === null) return; app.commit((k) => k.addBehavior('zmk,behavior-macro', name.trim().replace(/\W+/g, '_') || undefined)); } }, 'Add a macro');
  if (!macros.length) return h('section', { class: 'list-view' }, emptyState('A macro sends a sequence of key presses from one key.', add));
  return h('section', { class: 'list-view' }, h('div', { class: 'view-head' }, h('h2', null, 'Macros'), add), macros.map((b) => behaviorCard(app, b)));
}

export function behaviorsView(app) {
  const list = app.km.behaviors;
  const select = h('select', { 'aria-label': 'Behavior type' }, Object.entries(BEHAVIOR_TYPES).filter(([, t]) => !t.macro).map(([compat, t]) => h('option', { value: compat }, t.title)));
  const add = h('div', { class: 'add-typed' }, select, h('button', { class: 'primary', onClick: () => app.commit((k) => k.addBehavior(select.value)) }, 'Add a behavior'));
  if (!list.length) return h('section', { class: 'list-view' }, emptyState('Custom behaviors are your own versions of hold-tap, tap dance, mod-morph and friends, with their own timings.', add));
  return h('section', { class: 'list-view' }, h('div', { class: 'view-head' }, h('h2', null, 'Behaviors'), add), list.map((b) => behaviorCard(app, b)));
}
