import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keymap, bindingText } from '../public/js/core/keymap.js';
import { parseDts, printDts } from '../public/js/core/dts.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'keymaps', 'bundled');
const text = fs.readFileSync(path.join(dir, 'corne_choc_pro.keymap'), 'utf8');
const info = JSON.parse(fs.readFileSync(path.join(dir, 'corne_choc_pro.json'), 'utf8'));
const layout = info.layouts.default_layout.layout;
const load = () => new Keymap(text, layout, info.sensors);

test('parse and print gives back the exact file', () => {
  assert.equal(printDts(parseDts(text)), text);
});

test('extra keymaps round-trip too', () => {
  const extra = process.env.EXTRA_KEYMAPS ? process.env.EXTRA_KEYMAPS.split(':') : [];
  for (const f of extra) { const t = fs.readFileSync(f, 'utf8'); assert.equal(printDts(parseDts(t)), t, f); }
});

test('reads layers, combos, macros and behaviors', () => {
  const km = load();
  assert.deepEqual(km.layers.map((l) => l.label), ['OGM', 'LWR', 'RSD', 'CMBD']);
  assert.ok(km.layers.every((l) => l.bindings.length === 46));
  assert.equal(bindingText(km.layers[0].bindings[6]), '&kp LS(LG(X))');
  assert.equal(bindingText(km.layers[0].bindings[7]), '&caps_word');
  assert.equal(bindingText(km.layers[0].bindings[20]), '&sk LSHIFT');
  assert.equal(bindingText(km.layers[0].bindings[40]), '&oneshot_or_tab TAB LSHIFT');
  assert.equal(km.layers[0].sensorBindings.length, 4);
  assert.deepEqual(km.combos.map((c) => c.name), ['bt_clear', 'bt_0', 'combined', 'caps_word']);
  assert.deepEqual(km.combos[3].keyPositions, [22, 19]);
  assert.equal(km.macros.length, 11);
  assert.deepEqual(km.behaviors.map((b) => b.name), ['hmr', 'hml', 'sr_chj_mod_morph', 'one_shot', 'layertap_holdpref', 'oneshot_or_tab']);
  assert.deepEqual(km.behavior('hml').params, ['code', 'code']);
  assert.deepEqual(km.behavior('layertap_holdpref').params, ['layer', 'code']);
  assert.deepEqual(km.behavior('oneshot_or_tab').params, ['code', 'code']);
  assert.deepEqual(km.behavior('one_shot').params, ['code']);
  assert.equal(bindingText(km.macros.find((m) => m.name === 'sr_sh').node && km.getField(km.macros[0].node, { name: 'bindings', type: 'bindings' })[0]), '&kp LS(RA(NUMBER_6))');
});

test('rewriting every layer unchanged leaves the file byte-identical', () => {
  const km = load();
  km.layers.forEach((l, i) => { km.setLayerBindings(i, l.bindings); if (l.sensorBindings) km.setSensorBindings(i, l.sensorBindings); });
  assert.equal(km.toString(), text);
});

test('changing one key only touches lines of that layer', () => {
  const km = load();
  km.setBinding(1, 6, { behavior: 'kp', params: ['DEL'] });
  const a = text.split('\n'); const b = km.toString().split('\n');
  assert.equal(a.length, b.length);
  const changed = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
  assert.ok(changed.length >= 1 && changed.length <= 4, 'changed lines: ' + changed.length);
  const again = new Keymap(km.toString(), layout);
  assert.equal(bindingText(again.layers[1].bindings[6]), '&kp DEL');
  assert.equal(bindingText(again.layers[0].bindings[6]), '&kp LS(LG(X))');
});

test('layers can be added, moved and removed with references kept right', () => {
  const km = load();
  const idx = km.addLayer('Nav');
  assert.equal(idx, 4);
  let again = new Keymap(km.toString(), layout);
  assert.equal(again.layers.length, 5);
  assert.equal(again.layers[4].label, 'Nav');
  assert.equal(again.layers[4].bindings.length, 46);
  // move layer 1 (LWR) to position 2: &layertap_holdpref 1 TAB must follow it
  km.moveLayer(1, 2);
  again = new Keymap(km.toString(), layout);
  assert.deepEqual(again.layers.map((l) => l.label), ['OGM', 'RSD', 'LWR', 'CMBD', 'Nav']);
  assert.equal(bindingText(again.layers[0].bindings[41]), '&layertap_holdpref 2 TAB');
  assert.equal(bindingText(again.layers[0].bindings[44]), '&layertap_holdpref 1 ENTER');
  // remove CMBD (3): the combo "&mo 3" turns into &none
  km.removeLayer(3);
  again = new Keymap(km.toString(), layout);
  assert.equal(again.layers.length, 4);
  assert.equal(bindingText(again.combos.find((c) => c.name === 'combined').bindings[0]), '&none');
});

test('combos, conditional layers, behaviors and macros can be added and edited', () => {
  const km = load();
  const combo = km.addCombo();
  km.updateCombo(combo, { name: 'esc_combo', bindings: [{ behavior: 'kp', params: ['ESC'] }], keyPositions: [1, 2], layers: ['0'], timeoutMs: 40 });
  const cond = km.addConditionalLayer();
  km.updateConditionalLayer(cond, { ifLayers: ['1', '2'], thenLayer: '3' });
  const td = km.addBehavior('zmk,behavior-tap-dance', 'td_shift');
  const mac = km.addBehavior('zmk,behavior-macro', 'hello');
  km.setField(mac, { name: 'bindings', type: 'bindings' }, [{ behavior: 'kp', params: ['H'] }, { behavior: 'kp', params: ['I'] }]);
  km.setBinding(0, 0, { behavior: 'td_shift', params: [] });
  km.renameBehavior(td, 'td_caps');
  const out = km.toString();
  const again = new Keymap(out, layout);
  assert.equal(again.combos.at(-1).name, 'esc_combo');
  assert.deepEqual(again.combos.at(-1).keyPositions, [1, 2]);
  assert.equal(again.combos.at(-1).timeoutMs, 40);
  assert.deepEqual(again.conditionalLayers[0].ifLayers, ['1', '2']);
  assert.equal(again.conditionalLayers[0].thenLayer, '3');
  assert.ok(again.behavior('td_caps').custom);
  assert.equal(bindingText(again.layers[0].bindings[0]), '&td_caps');
  assert.equal(again.macros.at(-1).name, 'hello');
  again.removeBehavior(again.behavior('td_caps').node);
  assert.equal(bindingText(new Keymap(again.toString(), layout).layers[0].bindings[0]), '&none');
});
