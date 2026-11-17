import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keymap } from '../public/js/core/keymap.js';
import { ZmkKeys } from '../public/js/core/zmk-keys.js';
import { Qmk } from '../public/js/core/qmk.js';
import { translate } from '../public/js/core/translate.js';
import { buildVil, vilToText, packLayoutOptions, serializeMacros, deserializeMacros } from '../public/js/core/vil.js';
import { VialKeyboard, WebHidTransport, sideCell, sideOf, SIDE_CODES } from '../public/js/core/vial-hid.js';
import { MockVial } from './mock-vial.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const J = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const info = J('keymaps/bundled/corne_choc_pro.json');
const text = fs.readFileSync(path.join(root, 'keymaps/bundled/corne_choc_pro.keymap'), 'utf8');
const zk = new ZmkKeys(J('public/data/zmk-keys.json'));
const qmk = new Qmk(J('public/data/qmk-keycodes.json'));
const target = J('public/data/targets/corne_mx_pro.json');
const load = () => new Keymap(text, info.layouts.default_layout.layout, info.sensors);
const tr = () => translate(load(), zk, qmk, target, {});

test('every Vial keycode name round-trips through the decoder', () => {
  for (const [code, name] of qmk.nameOf) {
    if (name.endsWith('(kc)')) continue;
    assert.equal(qmk.decode(name), code, name);
  }
  for (const code of [0x21e, 0x0a1b, 0x1623, 0x2204, 0x380d, 0x3604, 0x412b, 0x52b6, 0x5700, 0x77ff, 0x7c73]) assert.equal(qmk.decode(qmk.serialize(code)), code);
});

test('your keymap translates as expected', () => {
  const t = tr();
  const L0 = t.keys[0].map((k) => k.name);
  assert.equal(L0[0], 'KC_ESCAPE');
  assert.equal(L0[6], 'SGUI(KC_X)');                 // &kp LS(LG(X))  = Cmd+Shift+X
  assert.equal(L0[7], 'QK_CAPS_WORD_TOGGLE');        // &caps_word
  assert.equal(L0[20], 'OSM(MOD_LSFT)');             // &sk LSHIFT
  assert.equal(L0[21], 'OSM(MOD_LSFT)');
  assert.equal(L0[15], 'LSFT_T(KC_A)');              // &hml LEFT_SHIFT A
  assert.equal(L0[23], 'RGUI_T(KC_J)');              // &hmr RIGHT_GUI J
  assert.equal(L0[41], 'LT1(KC_TAB)');               // &layertap_holdpref 1 TAB
  assert.equal(L0[44], 'LT2(KC_ENTER)');
  assert.equal(L0[40], 'TD(0)');                     // &oneshot_or_tab TAB LSHIFT
  assert.deepEqual(t.tapDance[0], ['OSM(MOD_LSFT)', 'KC_TAB', 'KC_NO', 'KC_NO', 180]);
  assert.deepEqual(t.combos, [['LT1(KC_TAB)', 'LT2(KC_ENTER)', 'KC_NO', 'KC_NO', 'MO(3)'], ['KC_H', 'KC_G', 'KC_NO', 'KC_NO', 'QK_CAPS_WORD_TOGGLE']]);
  assert.equal(t.macros.length, 12);                  // 11 in the file, and one for the mod-morph between two macros
  assert.deepEqual(t.macros[t.macroNames.indexOf('tmux_vim')], [['tap', 'LCTL(KC_A)', 'KC_LBRACKET']]);
  assert.equal(t.keys[3][28].name, 'QK_REBOOT');
  assert.equal(t.keys[3][22].status, 'unsupported');  // &bt BT_CLR_ALL
  assert.equal(t.summary.unsupported, 6);
  assert.equal(t.settings[7], 200);
  assert.equal(t.settings[27], 60);
  assert.equal(t.settings[26], undefined);            // same-hand positional rule is not QMK's chordal hold
});

test('a mod-morph between two macros gets a macro of its own and a key override for the custom firmware', () => {
  const t = tr();
  const n = (name) => t.macroNames.indexOf(name);
  assert.deepEqual([n('sr_chj'), n('sr_chj_uppercase'), n('sr_chj_mod_morph')], [2, 5, 11]);   // the file's macros keep their numbers
  assert.deepEqual(t.macros[11], t.macros[2]);
  assert.notEqual(t.macros[11], t.macros[2]);          // a copy, not the same list
  assert.deepEqual(t.keyOverrides, [{ trigger: 'M11', replacement: 'M5', layers: 1 << 2, trigger_mods: 0x22, negative_mod_mask: 0, suppressed_mods: 0x22, options: 0x87 }]);
  const key = t.keys[2][33];                           // &sr_chj_mod_morph
  assert.equal(key.name, 'M11');
  assert.equal(key.status, 'approx');
  assert.match(key.note, /"sr_chj_uppercase" \(M5\).*vial_custom.*stock firmware the key always runs "sr_chj"/);
  assert.equal(t.keys[2][31].name, 'M2');              // &sr_chj on its own key is not part of the rule
  assert.equal(t.keys[2][30].name, 'M5');

  // the same mod-morph on a second layer: still one macro and one entry, for both layers
  const twoKeys = text.replace('&kp C_PP ', '&sr_chj_mod_morph ').replace('&kp LS(LG(X))', '&sr_chj_mod_morph');
  const t2 = translate(new Keymap(twoKeys, info.layouts.default_layout.layout, info.sensors), zk, qmk, target, {});
  const where = t2.keys.flatMap((layer, li) => layer.map((k, pos) => (k.name === 'M11' ? `${li}:${pos}` : null)).filter(Boolean));
  assert.deepEqual(where, ['0:6', '2:33', '2:36']);   // layer 0 once, layer 2 twice
  assert.equal(t2.macros.length, 12);
  assert.equal(t2.keyOverrides.length, 1);
  assert.equal(t2.keyOverrides[0].layers, (1 << 0) | (1 << 2));

  // no free macro: the key stays on the first macro, and nothing is written for it
  const full = translate(load(), zk, qmk, { ...target, capacity: { ...target.capacity, macros: 11 } }, {});
  assert.equal(full.keys[2][33].name, 'M2');
  assert.match(full.keys[2][33].note, /no room for another macro/);
  assert.equal(full.macros.length, 11);
  assert.deepEqual(full.keyOverrides, []);
});

test('overrides replace a key for the Vial board only', () => {
  const t = translate(load(), zk, qmk, target, { overrides: { '3:22': 'QK_BOOT', '3:13': 'not a key' } });
  assert.equal(t.keys[3][22].name, 'QK_BOOT');
  assert.equal(t.keys[3][22].status, 'override');
  assert.equal(t.keys[3][13].status, 'unsupported');
});

test('.vil file has the shape Vial writes', () => {
  const vil = buildVil(tr());
  const txt = vilToText(vil, target.uid);
  assert.ok(txt.includes('"uid":5010774632021243529,'));
  const back = JSON.parse(txt.replace(target.uid, '0'));
  assert.equal(back.layout.length, 4);
  assert.equal(back.layout[0].length, 8);
  assert.equal(back.layout[0][0].length, 7);
  assert.equal(back.layout[0][0][6], 'SGUI(KC_X)');   // left inner top = matrix (0,6)
  assert.equal(back.layout[0][4][6], 'QK_CAPS_WORD_TOGGLE'); // right inner top = matrix (4,6)
  assert.equal(back.layout[0][1][6], 'OSM(MOD_LSFT)');
  assert.equal(back.layout[0][5][6], 'OSM(MOD_LSFT)');
  assert.equal(back.layout[0][2][6], -1);
  assert.equal(back.layout[0][3][0], -1);
  assert.equal(back.layout[0][3][3], 'TD(0)');
  assert.equal(back.layout[0][4][0], 'KC_KP_SLASH');
  assert.equal(back.encoder_layout[0].length, 4);
  assert.equal(back.tap_dance.length, 32);
  assert.equal(back.combo.length, 32);
  assert.equal(back.key_override.length, 32);
  assert.equal(back.macro.length, 16);
  assert.equal(packLayoutOptions([0, 1, 2, 1], target.layoutOptions), 0b00011001);
});

test('every name in the export is one Vial\'s own loader accepts', () => {
  // vial-accepts.json is read out of vial-gui's source: registered keycode ids, the functions its
  // expression reader knows, and the names usable inside those expressions.
  const acc = J('test/vial-accepts.json');
  const ids = new Set(acc.ids); const fns = new Set(acc.functions); const inner = new Set(acc.anyNames);
  const accepts = (name) => {
    if (name === -1 || ids.has(name)) return true;
    let m;
    if ((m = /^(MO|DF|TG|TT|OSL|TO|PDF)\((\d+)\)$/.exec(name))) return Number(m[2]) < 16;
    if ((m = /^M(\d+)$/.exec(name))) return Number(m[1]) < 16;
    if ((m = /^TD\((\d+)\)$/.exec(name))) return Number(m[1]) < 256;
    let i = 0;
    const ws = () => { while (name[i] === ' ') i++; };
    const expr = () => { if (!term()) return false; ws(); while (name[i] === '|') { i++; if (!term()) return false; ws(); } return true; };
    const term = () => {
      ws();
      const num = /^(0x[0-9a-fA-F]+|\d+)/.exec(name.slice(i));
      if (num) { i += num[0].length; return true; }
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(name.slice(i));
      if (!id) return false;
      i += id[0].length;
      if (name[i] !== '(') return inner.has(id[0]);
      if (!fns.has(id[0])) return false;
      i++;
      for (;;) { if (!expr()) return false; ws(); if (name[i] === ',') { i++; continue; } break; }
      if (name[i] !== ')') return false;
      i++;
      return true;
    };
    return expr() && i === name.length;
  };
  assert.ok(accepts('LSFT_T(KC_A)') && accepts('RSFT(RALT(KC_6))') && accepts('MT(MOD_RSFT|MOD_RALT, KC_A)') && accepts('0x1623'));
  assert.ok(!accepts('KC_BOGUS') && !accepts('LSFT(QK_BOOT)') && !accepts('NOPE(KC_A)'));
  const vil = buildVil(tr());
  const names = [
    ...vil.layout.flat(2), ...vil.encoder_layout.flat(2), ...vil.tap_dance.flatMap((e) => e.slice(0, 4)), ...vil.combo.flat(),
    ...vil.key_override.flatMap((e) => [e.trigger, e.replacement]), ...vil.macro.flat().filter((a) => a[0] !== 'delay' && a[0] !== 'text').flatMap((a) => a.slice(1)),
  ];
  assert.ok(names.length > 600);
  const rejected = [...new Set(names.filter((n) => !accepts(n)))];
  assert.deepEqual(rejected, []);
  // and every name the exporter can produce for any code in the tables
  const all = [...qmk.nameOf.entries()].filter(([, n]) => !n.endsWith('(kc)')).map(([c]) => qmk.serialize(c));
  for (let l = 0; l < 16; l++) all.push(qmk.serialize(qmk.layerTap(l, 0x2B)));
  for (let m = 1; m < 32; m++) { all.push(qmk.serialize(qmk.withMods(0x04, m)), qmk.serialize(qmk.modTap(m, 0x04)), qmk.serialize(qmk.osm(m))); }
  const known = (n) => accepts(n) || /^(MO|DF|TG|TT|OSL|TO|PDF)\(\d+\)$/.test(n) || /^M\d+$/.test(n);
  assert.deepEqual([...new Set(all.filter((n) => !known(n)))], []);
});

test('macros survive the trip to bytes and back', () => {
  const t = tr();
  const bytes = serializeMacros(t.macros, 16, qmk);
  assert.deepEqual(deserializeMacros(bytes, 16, qmk).slice(0, t.macros.length), t.macros);
  // 2-byte keycode with a zero low byte uses the 0xFF escape
  assert.deepEqual([...serializeMacros([[['tap', 'KC_A', 'LSFT(KC_B)'], ['delay', 300], ['down', '0x5200']]], 1, qmk)], [1, 1, 4, 1, 5, 5, 2, 1, 4, 46, 2, 1, 6, 0x52, 0xFF, 0]);
});

// a request that changes nothing on the keyboard
const isRead = (m) => [0x01, 0x02, 0x04, 0x0C, 0x0D, 0x0E, 0x11, 0x12].includes(m[0])
  || (m[0] === 0xFE && ([0x00, 0x03, 0x05, 0x09, 0x0A].includes(m[1]) || (m[1] === 0x0D && [0, 1, 3, 5, 7].includes(m[2]))));

test('writing to a (mock) keyboard: backup, unlock, write, verify', async () => {
  const dev = new MockVial();
  // some existing content, so the backup has something in it
  await dev.send(Uint8Array.from([0x05, 0, 0, 0, 0x00, 0x29, ...new Array(26).fill(0)]));
  const kb = new VialKeyboard(dev, qmk);
  const before = await kb.readState(target);
  assert.equal(before.layers, 16);
  assert.equal(before.keymap[0][0][0], 0x29);
  assert.equal(before.settings[7], 200);
  const backup = kb.stateToVil(before, target);
  assert.equal(backup.layout[0][0][0], 'KC_ESCAPE');
  assert.equal(backup.layout[0][2][6], -1);
  assert.equal(backup.key_override[0].options, 7);

  const t = tr();
  const plan = kb.plan(t, before, target);
  assert.ok(plan.needsUnlock);
  assert.ok(plan.summary.keys > 100);
  assert.equal(plan.summary.macros, 1);

  // locked: the firmware would ignore the macros and answer as if all were well. The write stops before it
  // changes anything, so no key is left pointing at a macro that was never stored.
  const sent = dev.log.length;
  await assert.rejects(kb.apply(plan), /locked/);
  assert.ok(dev.log.slice(sent).every(isRead), 'nothing but questions was sent');
  let after = await kb.readState(target);
  assert.deepEqual(after.keymap, before.keymap);
  assert.deepEqual(after.macroBytes, before.macroBytes);

  // unlock (the mock "holds" the keys), then everything goes through
  dev.holding = true;
  assert.equal(await kb.unlock({ pollMs: 1 }), true);
  await kb.apply(plan);
  after = await kb.readState(target);
  const again = kb.plan(t, after, target);
  assert.equal(again.ops.length, 0);
  assert.equal(after.keymap[0][0][6], 0x0A1B);
  assert.equal(after.keymap[0][4][6], 0x7C73);
  assert.equal(after.keymap[0][3][3], 0x5700);
  assert.deepEqual(after.tapDance[0], [0x52A2, 0x2B, 0, 0, 180]);
  assert.deepEqual(after.combos[1], [0x0B, 0x0A, 0, 0, 0x7C73]);
  assert.equal(after.settings[25], 80);
  assert.deepEqual(kb.stateToVil(after, target).macro.slice(0, t.macros.length), t.macros);
  // the mod-morph between two macros: a key override from its own macro (M11) to the capital's macro (M5)
  assert.deepEqual(after.keyOverrides[0], { trigger: 0x770B, replacement: 0x7705, layers: 4, trigger_mods: 0x22, negative_mod_mask: 0, suppressed_mods: 0x22, options: 0x87 });
  // layers the keymap does not use are untouched
  assert.ok(after.keymap.slice(4).every((l) => l.every((r) => r.every((c) => c === 0))));
  await kb.lock();
});

test('a keyboard that says it is unlocked but does not take macros is caught by the first byte written', async () => {
  const dev = new MockVial();
  const kb = new VialKeyboard(dev, qmk);
  const before = await kb.readState(target);
  const plan = kb.plan(tr(), before, target);
  const real = dev.send.bind(dev);
  dev.send = async (msg) => { const d = await real(msg); if (msg[0] === 0xFE && msg[1] === 0x05) d[0] = 1; return d; };
  const sent = dev.log.length;
  await assert.rejects(kb.apply(plan), /locked/);
  dev.send = real;
  // the one write that went out is the macro switch-off byte, which the keyboard ignored; no key was touched
  assert.deepEqual(dev.log.slice(sent).filter((m) => !isRead(m)).map((m) => [...m.slice(0, 5)]), [[0x0F, (before.macroSize - 1) >> 8, (before.macroSize - 1) & 0xFF, 1, 0xFF]]);
  const after = await kb.readState(target);
  assert.deepEqual(after.keymap, before.keymap);
  assert.equal(after.macrosOff, false);
});

test('a macro that holds a key which is not a plain key gets a warning', () => {
  const src = text.replace('<&kp LSHFT &kp RSHFT>,', '<&kp LSHFT &kp RSHFT &mo 1>,');
  assert.notEqual(src, text);
  const t = translate(new Keymap(src, info.layouts.default_layout.layout, info.sensors), zk, qmk, target, {});
  assert.ok(t.issues.some((i) => /sr_chj_uppercase/.test(i.text || i.message || JSON.stringify(i)) && /stop responding/.test(JSON.stringify(i))));
  assert.ok(!tr().issues.some((i) => /stop responding/.test(JSON.stringify(i))), 'the macros of the bundled keymap are all plain keys');
});

test('macros are switched off while they are written, and a write cut short leaves them off', async () => {
  const t = tr();
  const dev = new MockVial(); dev.holding = true;
  const last = dev.macroSize - 1;
  const kb = new VialKeyboard(dev, qmk);
  let plan = kb.plan(t, await kb.readState(target), target);
  assert.equal(await kb.unlock({ pollMs: 1 }), true);
  const from = dev.log.length;
  await kb.apply(plan);
  const writes = dev.log.slice(from).filter((m) => m[0] === 0x0F).map((m) => [(m[1] << 8) | m[2], m[3], m[4]]);
  assert.deepEqual(writes[0], [last, 1, 0xFF], 'first the macros are switched off');
  assert.deepEqual(writes.at(-1), [last, 1, 0x00], 'last they are switched on');
  assert.ok(writes.length > 4 && writes.slice(1, -1).every(([off, size]) => off + size <= last));
  assert.equal(dev.macro[last], 0);
  assert.equal((await kb.readState(target)).macrosOff, false);

  // the cable comes out after two packets of macros
  const dev2 = new MockVial(); dev2.holding = true;
  let n = 0;
  const pulled = { send: async (m) => { if (m[0] === 0x0F && ++n > 3) throw new Error('The keyboard did not answer.'); return dev2.send(m); } };
  const kb2 = new VialKeyboard(pulled, qmk);
  plan = kb2.plan(t, await kb2.readState(target), target);
  assert.equal(await kb2.unlock({ pollMs: 1 }), true);
  await assert.rejects(kb2.apply({ ...plan, ops: plan.ops.filter((o) => o.type === 'macros') }), /did not answer\. The macros on the keyboard are switched off/);
  assert.equal(dev2.macro[last], 0xFF, 'the firmware runs no macro in this state');

  // plugged in again: the app sees it, says so, and the next write puts it right
  const kb3 = new VialKeyboard(dev2, qmk);
  const state = await kb3.readState(target);
  assert.equal(state.macrosOff, true);
  plan = kb3.plan(t, state, target);
  assert.ok(plan.notes.some((x) => /switched off/.test(x)));
  assert.equal(plan.summary.macros, 1);
  await kb3.apply(plan);
  assert.equal(dev2.macro[last], 0);
  assert.equal(kb3.plan(t, await kb3.readState(target), target).ops.length, 0);
});

test('a macro that would hold a zero byte is refused before anything is sent', () => {
  assert.throws(() => serializeMacros([[['tap', 'KC_NO']]], 4, qmk), /Macro M0 cannot be stored/);
  assert.throws(() => serializeMacros([[], [['delay', 65025]]], 4, qmk), /Macro M1 cannot be stored/);
  assert.throws(() => serializeMacros([[['delay', -1]]], 4, qmk), /cannot be stored/);
  assert.throws(() => serializeMacros([[['text', 'a\0b']]], 4, qmk), /cannot be stored/);
  // the longest delay that fits, and an ordinary key: four macros, four end marks, no other zero
  assert.equal(serializeMacros([[['delay', 65024]], [['tap', 'KC_A']]], 4, qmk).filter((b) => b === 0).length, 4);
});

test('the keyboard is refused when its USB vendor, its VIA version or its answers are not as expected', async () => {
  const dev = new MockVial();
  const other = new VialKeyboard({ send: (m) => dev.send(m), vendorId: 0x1234, productId: 4 }, qmk);
  await assert.rejects(other.readState(target), /not a Keebart Corne MX Pro/);
  assert.equal(dev.log.length, 0, 'it was not even asked anything');
  // the ids a real keyboard gave (2026-11): vendor 0xFEED, product 0
  const real = new VialKeyboard({ send: (m) => dev.send(m), vendorId: 0xFEED, productId: 0 }, qmk);
  assert.equal((await real.readState(target)).layers, 16);
  const old = new VialKeyboard({ send: async (m) => { const d = await dev.send(m); if (m[0] === 0x01) d[2] = 8; return d; } }, qmk);
  await assert.rejects(old.readState(target), /VIA protocol 8/);
  const short = new VialKeyboard({ send: async (m) => (await dev.send(m)).subarray(0, 16) }, qmk);
  await assert.rejects(short.readState(target), /wrong size/);
});

test('a different keyboard is refused', async () => {
  const dev = new MockVial({ uidBytes: [1, 2, 3, 4, 5, 6, 7, 8] });
  await assert.rejects(new VialKeyboard(dev, qmk).readState(target), /not a Keebart Corne MX Pro/);
});

test('the mark for left or right sits where no key is, and a full write leaves it alone', async () => {
  const cell = sideCell(target);
  assert.deepEqual(cell, { layer: 15, row: 3, col: 0 });
  assert.ok(!target.matrixKeys.some((k) => k.row === cell.row && k.col === cell.col));
  assert.ok(!target.positions.some(([r, c]) => r === cell.row && c === cell.col));
  // a mark that would land on a real key is not used at all
  assert.equal(sideCell({ ...target, sideCell: { layer: 15, row: 0, col: 0 } }), null);
  assert.equal(sideCell({ ...target, sideCell: { layer: 16, row: 3, col: 0 } }), null);

  const dev = new MockVial();
  const kb = new VialKeyboard(dev, qmk);
  assert.equal(await kb.readSide(target), null);
  const before = dev.dump();
  assert.equal(await kb.writeSide(target, 'left'), 'left');
  assert.equal(await kb.readSide(target), 'left');
  // exactly one keycode changed, and it is not one Vial shows or saves
  const o = dev.kOff(cell.layer, cell.row, cell.col);
  const diff = [...Buffer.from(dev.dump().keymap, 'hex')].map((b, i) => (b !== Buffer.from(before.keymap, 'hex')[i] ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(diff, [o + 1]);
  assert.equal((dev.keymap[o] << 8) | dev.keymap[o + 1], SIDE_CODES.left);
  assert.deepEqual({ ...dev.dump(), keymap: '' }, { ...before, keymap: '' });

  // a full keymap write, checked the way the app checks it, neither touches the mark nor trips over it
  dev.holding = true;
  let state = await kb.readState(target);
  assert.equal(sideOf(state, target), 'left');
  assert.equal(kb.stateToVil(state, target).layout[cell.layer][cell.row][cell.col], -1); // not in the backup file
  const plan = kb.plan(tr(), state, target);
  assert.ok(!plan.ops.some((op) => op.type === 'key' && op.layer === cell.layer && op.row === cell.row && op.col === cell.col));
  assert.equal(await kb.unlock({ pollMs: 1 }), true);
  await kb.apply(plan);
  state = await kb.readState(target);
  assert.equal(kb.plan(tr(), state, target).ops.length, 0);
  assert.equal(sideOf(state, target), 'left');

  assert.equal(await kb.writeSide(target, 'right'), 'right');
  assert.equal(await kb.readSide(target), 'right');
  assert.equal(await kb.writeSide(target, null), null);
  assert.equal(await kb.readSide(target), null);
  await assert.rejects(kb.writeSide(target, 'middle'), /left or right/);
  // only the mark's own two commands were used for marking: read keycode (0x04) and set keycode (0x05)
  const other = new MockVial();
  await new VialKeyboard(other, qmk).writeSide(target, 'right');
  assert.deepEqual(other.log.map((m) => (m[0] === 0xFE ? `fe${m[1].toString(16).padStart(2, '0')}` : m[0].toString(16).padStart(2, '0'))), ['01', 'fe00', 'fe05', '05', '04']);
});

test('the mark is never written to another keyboard, or to the Mini', async () => {
  const stranger = new MockVial({ uidBytes: [1, 2, 3, 4, 5, 6, 7, 8] });
  await assert.rejects(new VialKeyboard(stranger, qmk).writeSide(target, 'left'), /not a Keebart Corne MX Pro/);
  await assert.rejects(new VialKeyboard(stranger, qmk).readSide(target), /not a Keebart Corne MX Pro/);
  const mini = new MockVial({ productId: 0x0104 });
  await assert.rejects(new VialKeyboard(mini, qmk).writeSide(target, 'left'), /Mini/);
  await assert.rejects(new VialKeyboard(mini, qmk).readState(target), /Mini/);
  for (const dev of [stranger, mini]) assert.ok(!dev.log.some((m) => m[0] === 0x05), 'no write was sent');
  // a keyboard with fewer layers than the mark needs: the firmware drops the write, and the app notices
  const small = new MockVial({ layers: 8 });
  await assert.rejects(new VialKeyboard(small, qmk).writeSide(target, 'left'), /did not keep the mark/);
});

test('an unlock that was started and never finished is reported, and nothing is read or written', async () => {
  const dev = new MockVial();
  const kb = new VialKeyboard(dev, qmk);
  await dev.send(Uint8Array.from([0xFE, 0x06, ...new Array(30).fill(0)])); // unlock started, keys never held
  const sent = dev.log.length;
  await assert.rejects(kb.readState(target), /unlock that was started and not finished/);
  await assert.rejects(kb.writeSide(target, 'left'), /unlock that was started and not finished/);
  assert.ok(dev.log.slice(sent).every((m) => m[0] === 0x01 || m[0] === 0xFE), 'only identity and unlock-status questions were sent');
  // holding the keys finishes it, and the keyboard answers again
  dev.holding = true;
  assert.equal(await kb.unlock({ pollMs: 1 }), true);
  assert.equal((await kb.readState(target)).layers, 16);
});

test('an answer that belongs to another request stops everything', async () => {
  const dev = new MockVial();
  let n = 0;
  // every third answer is the answer to something else, as when another program talks to the keyboard too
  const noisy = { send: async (m) => { const d = await dev.send(m); if (m[0] === 0x12 && ++n === 3) d[2] ^= 0x40; return d; } };
  await assert.rejects(new VialKeyboard(noisy, qmk).readState(target), /belongs to a different request/);
  const lost = { send: async (m) => { const d = await dev.send(m); if (m[0] === 0x04) d[0] = 0x12; return d; } };
  await assert.rejects(new VialKeyboard(lost, qmk).readSide(target), /belongs to a different request/);
});

test('a late answer is thrown away, never taken for the answer to the next request', async () => {
  // a pretend browser HID device: like the firmware, it answers every packet once and in the order they came,
  // here with the packet's own first byte, after a chosen delay
  const listeners = new Set(); const delays = [60, 5, 5];
  let line = Promise.resolve();
  const device = {
    opened: true, productName: 'Corne MX Pro', vendorId: 0xFEED, productId: 4,
    addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn),
    sendReport: async (_, msg) => {
      const out = Uint8Array.from(msg);
      const ready = new Promise((r) => setTimeout(r, delays.shift() ?? 5));
      line = Promise.all([line, ready]).then(() => listeners.forEach((fn) => fn({ data: new DataView(out.buffer) })));
    },
    close: async () => {},
  };
  const t = new WebHidTransport(device);
  const packet = (b) => { const m = new Uint8Array(32); m[0] = b; return m; };
  await assert.rejects(t.send(packet(0xA1), 20), /did not answer/);   // its answer is still on the way
  const second = await t.send(packet(0xB2), 300);                     // the late 0xA1 arrives first and must be dropped
  assert.equal(second[0], 0xB2);
  assert.equal((await t.send(packet(0xC3), 300))[0], 0xC3);
  assert.equal(t.productId, 4);
  await t.close();
  assert.equal(listeners.size, 0);
});
