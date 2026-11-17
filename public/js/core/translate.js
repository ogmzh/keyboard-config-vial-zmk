// Turns the ZMK keymap into what a Vial (QMK) keyboard understands:
// keycodes per key, tap dances, combos, key overrides, macros, encoder actions and tap-hold settings.
// Every key gets a status so the UI can show exactly what carried over and what did not.

import { parseBindings, bindingText } from './keymap.js';
import { propTokens, propString, getProp } from './dts.js';
import { Qmk, QK } from './qmk.js';

const CONSUMER = {
  0xE9: 'KC_VOLU', 0xEA: 'KC_VOLD', 0xE2: 'KC_MUTE', 0xCD: 'KC_MPLY', 0xB0: 'KC_MPLY', 0xB1: 'KC_MPLY', 0xB5: 'KC_MNXT', 0xB6: 'KC_MPRV',
  0xB7: 'KC_MSTP', 0xB8: 'KC_EJCT', 0xB3: 'KC_MFFD', 0xB4: 'KC_MRWD', 0x6F: 'KC_BRIU', 0x70: 'KC_BRID',
  0x192: 'KC_CALC', 0x18A: 'KC_MAIL', 0x183: 'KC_MSEL', 0x194: 'KC_MYCM', 0x221: 'KC_WSCH', 0x223: 'KC_WHOM',
  0x224: 'KC_WBAK', 0x225: 'KC_WFWD', 0x226: 'KC_WSTP', 0x227: 'KC_WREF', 0x22A: 'KC_WFAV',
};
const DESKTOP = { 0x81: 'KC_PWR', 0x82: 'KC_SLEP', 0x83: 'KC_WAKE' };
const RGB = {
  RGB_TOG: 'RGB_TOG', RGB_HUI: 'RGB_HUI', RGB_HUD: 'RGB_HUD', RGB_SAI: 'RGB_SAI', RGB_SAD: 'RGB_SAD', RGB_BRI: 'RGB_VAI', RGB_BRD: 'RGB_VAD',
  RGB_SPI: 'RGB_SPI', RGB_SPD: 'RGB_SPD', RGB_EFF: 'RGB_MOD', RGB_EFR: 'RGB_RMOD',
};
const BACKLIGHT = { BL_TOG: 'BL_TOGG', BL_ON: 'BL_ON', BL_OFF: 'BL_OFF', BL_INC: 'BL_INC', BL_DEC: 'BL_DEC', BL_CYCLE: 'BL_STEP' };
const MOUSE = {
  LCLK: 'KC_BTN1', RCLK: 'KC_BTN2', MCLK: 'KC_BTN3', MB1: 'KC_BTN1', MB2: 'KC_BTN2', MB3: 'KC_BTN3', MB4: 'KC_BTN4', MB5: 'KC_BTN5',
  MOVE_UP: 'KC_MS_U', MOVE_DOWN: 'KC_MS_D', MOVE_LEFT: 'KC_MS_L', MOVE_RIGHT: 'KC_MS_R',
  SCRL_UP: 'KC_WH_U', SCRL_DOWN: 'KC_WH_D', SCRL_LEFT: 'KC_WH_L', SCRL_RIGHT: 'KC_WH_R',
};
const WIRELESS = { bt: 'Bluetooth', out: 'Output selection', ext_power: 'External power', soft_off: 'Soft off', studio_unlock: 'ZMK Studio unlock' };

export const EMPTY_TAP_DANCE = ['KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 200];
export const EMPTY_COMBO = ['KC_NO', 'KC_NO', 'KC_NO', 'KC_NO', 'KC_NO'];
export const EMPTY_OVERRIDE = { trigger: 'KC_NO', replacement: 'KC_NO', layers: 0xFFFF, trigger_mods: 0, negative_mod_mask: 0, suppressed_mods: 0, options: 7 };

const ok = (code, note) => ({ code, status: 'ok', note });
const approx = (code, note) => ({ code, status: 'approx', note });
const unsupported = (note) => ({ code: QK.NO, status: 'unsupported', note });
const worst = (...rs) => (rs.some((r) => r.status === 'unsupported') ? 'unsupported' : rs.some((r) => r.status === 'approx') ? 'approx' : 'ok');

export function translate(km, zk, qmk, target, opts = {}) {
  return new Translator(km, zk, qmk, target, opts).run();
}

class Translator {
  constructor(km, zk, qmk, target, opts) {
    this.km = km; this.zk = zk; this.qmk = qmk; this.target = target;
    this.opts = { overrides: {}, macroDelays: 'explicit', swapEncoders: false, applySettings: true, ...opts };
    this.issues = [];
    this.tapDances = []; this.tdKeys = new Map();
    this.macros = []; this.macroNames = []; this.macroIdx = new Map();
    this.overrides = []; this.overrideKeys = new Map(); this.morphMacros = new Map();
    this.features = { bluetooth: false, backlight: false, rgb: true, mouse: true, ...(target.features || {}) };
    this.cap = { macros: 16, tapDance: 32, combos: 32, keyOverrides: 32, ...(target.capacity || {}) };
    this.layerCtx = 0;
  }

  issue(level, where, message) { this.issues.push({ level, where, message }); }
  name(code) { return this.qmk.serialize(code); }

  // ---------- keys ----------

  key(expr) {
    const u = this.zk.resolve(expr);
    if (!u) return unsupported(`Unknown key "${expr}"`);
    let kc;
    if (u.page === 7) {
      if (u.id > 0xFF) return unsupported(`"${expr}" has no QMK keycode`);
      kc = u.id;
    } else {
      const nm = u.page === 12 ? CONSUMER[u.id] : u.page === 1 ? DESKTOP[u.id] : null;
      if (!nm) return unsupported(`"${expr}" has no QMK keycode`);
      kc = this.qmk.decode(nm);
    }
    const { mod5, mixed, altFlipped } = Qmk.mod5From8(u.mods);
    const code = this.qmk.withMods(kc, mod5);
    if (altFlipped) return approx(code, 'QMK cannot mix left and right modifiers on one key, so left Alt becomes right Alt (AltGr) here');
    return ok(code, mixed ? 'Sent with right-hand modifiers (QMK cannot mix sides on one key)' : undefined);
  }

  // A modifier key such as LSHIFT or LS(LCTRL): returns the 8-bit modifier mask, or null.
  modMask(expr) {
    const p = this.zk.parse(expr);
    if (!p.entry || p.entry.page !== 7 || p.entry.id < 224 || p.entry.id > 231) return null;
    return (1 << (p.entry.id - 224)) | p.modBits | p.entry.mods;
  }

  layer(token) {
    const n = this.km.resolveLayer(token);
    if (n === null) return { error: `Layer "${token}" is not a number` };
    if (n >= this.km.layerNodes.length) return { error: `Layer ${n} does not exist` };
    if (n >= this.target.layers) return { error: `Layer ${n} is beyond the ${this.target.layers} layers this keyboard has` };
    return { n };
  }

  // ---------- one binding ----------

  binding(b, depth = 0) {
    if (depth > 6) return unsupported('Behaviors refer to each other in a loop');
    const info = this.km.behavior(b.behavior);
    const p = b.params;
    if (info.custom) return this.custom(info, b, depth);
    switch (b.behavior) {
      case 'kp': return p[0] ? this.key(p[0]) : unsupported('Missing key');
      case 'trans': return ok(QK.TRNS);
      case 'none': return ok(QK.NO);
      case 'mt': return this.holdTap({ behavior: 'kp', params: [p[0]] }, { behavior: 'kp', params: [p[1]] }, null, depth);
      case 'lt': return this.holdTap({ behavior: 'mo', params: [p[0]] }, { behavior: 'kp', params: [p[1]] }, null, depth);
      case 'mo': case 'to': case 'tog': case 'sl': {
        const l = this.layer(p[0]);
        if (l.error) return unsupported(l.error);
        return ok({ mo: QK.MOMENTARY, to: QK.TO, tog: QK.TOGGLE_LAYER, sl: QK.ONE_SHOT_LAYER }[b.behavior] + l.n);
      }
      case 'sk': return this.sticky(p[0]);
      case 'kt': { const r = this.key(p[0] || ''); return r.status === 'unsupported' ? r : approx(r.code, 'Key toggle has no QMK equivalent; this is a normal key press'); }
      case 'caps_word': return ok(QK.CAPS_WORD);
      case 'key_repeat': return ok(QK.REPEAT);
      case 'gresc': return ok(QK.GESC);
      case 'bootloader': return ok(QK.BOOT);
      case 'sys_reset': return ok(QK.REBOOT);
      case 'rgb_ug': {
        if (!this.features.rgb) return unsupported('This keyboard has no RGB lighting');
        if (RGB[p[0]]) return ok(this.qmk.decode(RGB[p[0]]));
        if (p[0] === 'RGB_ON' || p[0] === 'RGB_OFF') return approx(this.qmk.decode('RGB_TOG'), 'QMK has only an RGB toggle here');
        return unsupported('Setting a fixed colour from a key is not available in Vial; set the colour in the Lighting tab');
      }
      case 'bl': {
        if (!this.features.backlight) return unsupported('This keyboard has no backlight');
        return BACKLIGHT[p[0]] ? ok(this.qmk.decode(BACKLIGHT[p[0]])) : unsupported('No QMK equivalent');
      }
      case 'mkp': case 'mmv': case 'msc':
        return MOUSE[p[0]] ? ok(this.qmk.decode(MOUSE[p[0]])) : unsupported(`"${p[0]}" has no QMK mouse key`);
      default:
        if (WIRELESS[b.behavior]) return unsupported(`${WIRELESS[b.behavior]} does not apply to a wired keyboard`);
        if (info.macro) return unsupported('Macro control outside a macro');
        return unsupported(`"&${b.behavior}" is not known`);
    }
  }

  sticky(expr) {
    const mask = this.modMask(expr || '');
    if (mask !== null) {
      const { mod5, altFlipped } = Qmk.mod5From8(mask);
      const code = this.qmk.osm(mod5);
      return altFlipped ? approx(code, 'Left and right modifiers cannot be mixed; left Alt becomes right Alt here') : ok(code);
    }
    const r = this.key(expr || '');
    return r.status === 'unsupported' ? r : approx(r.code, 'Sticky keys work only for modifiers in QMK; this is a normal key press');
  }

  holdTap(holdB, tapB, node, depth) {
    const tap = this.binding(tapB, depth + 1);
    const holdInfo = this.km.behavior(holdB.behavior);
    const tapInfo = this.km.behavior(tapB.behavior);
    const basicTap = tapInfo.builtin && tapB.behavior === 'kp' && tap.status !== 'unsupported' && tap.code < 0x100;
    if (holdInfo.builtin && holdB.behavior === 'kp' && basicTap) {
      const mask = this.modMask(holdB.params[0] || '');
      if (mask !== null) {
        const { mod5, altFlipped } = Qmk.mod5From8(mask);
        const code = this.qmk.modTap(mod5, tap.code);
        return altFlipped ? approx(code, 'Left and right modifiers cannot be mixed; left Alt becomes right Alt here') : ok(code);
      }
    }
    if (holdInfo.builtin && holdB.behavior === 'mo' && basicTap) {
      const l = this.layer(holdB.params[0]);
      if (l.error) return unsupported(l.error);
      if (l.n < 16) return ok(this.qmk.layerTap(l.n, tap.code));
    }
    const hold = this.binding(holdB, depth + 1);
    if (tap.status === 'unsupported' && hold.status === 'unsupported') return unsupported(tap.note || hold.note);
    const term = node ? Number((propTokens(node, 'tapping-term-ms') || [200])[0]) || 200 : 200;
    const td = this.tapDance([tap.code, hold.code, QK.NO, QK.NO, term]);
    if (td.error) return unsupported(td.error);
    const st = worst(tap, hold);
    return { code: td.code, status: st === 'ok' ? 'ok' : 'approx', note: `Tap dance: tap ${this.name(tap.code)}, hold ${this.name(hold.code)}` + (st !== 'ok' ? ` (${tap.note || hold.note})` : '') };
  }

  tapDance(entry) {
    const key = entry.join(',');
    if (this.tdKeys.has(key)) return { code: QK.TAP_DANCE + this.tdKeys.get(key) };
    if (this.tapDances.length >= this.cap.tapDance) return { error: `More than ${this.cap.tapDance} tap dances are needed` };
    this.tdKeys.set(key, this.tapDances.length);
    this.tapDances.push(entry);
    return { code: QK.TAP_DANCE + this.tapDances.length - 1 };
  }

  custom(info, b, depth) {
    const node = info.node;
    const refs = parseBindings(propTokens(node, 'bindings'));
    switch (info.compatible) {
      case 'zmk,behavior-hold-tap': {
        if (refs.length < 2) return unsupported('Hold-tap needs two behaviors');
        return this.holdTap({ behavior: refs[0].behavior, params: [b.params[0]] }, { behavior: refs[1].behavior, params: [b.params[1]] }, node, depth);
      }
      case 'zmk,behavior-sticky-key': {
        const inner = refs[0] ? refs[0].behavior : 'kp';
        if (this.km.behavior(inner).builtin && inner === 'mo') {
          const l = this.layer(b.params[0]);
          return l.error ? unsupported(l.error) : ok(QK.ONE_SHOT_LAYER + l.n);
        }
        return this.sticky(b.params[0]);
      }
      case 'zmk,behavior-tap-dance': {
        if (!refs.length) return unsupported('Empty tap dance');
        const rs = refs.slice(0, 2).map((r) => this.binding(r, depth + 1));
        const term = Number((propTokens(node, 'tapping-term-ms') || [200])[0]) || 200;
        const td = this.tapDance([rs[0].code, QK.NO, rs[1] ? rs[1].code : QK.NO, QK.NO, term]);
        if (td.error) return unsupported(td.error);
        if (refs.length > 2) return approx(td.code, 'Vial tap dances support one and two taps; further taps are dropped');
        return { code: td.code, status: worst(...rs) === 'ok' ? 'ok' : 'approx', note: rs.map((r) => r.note).filter(Boolean).join('; ') || undefined };
      }
      case 'zmk,behavior-mod-morph': return this.modMorph(info, refs, depth);
      case 'zmk,behavior-macro': {
        const idx = this.macro(info);
        if (idx.error) return unsupported(idx.error);
        return idx.status === 'ok' ? ok(QK.MACRO + idx.n) : { ...approx(QK.MACRO + idx.n, idx.note), reported: true };
      }
      case 'zmk,behavior-caps-word': return approx(QK.CAPS_WORD, 'Custom caps-word settings are not carried over');
      case 'zmk,behavior-key-repeat': return ok(QK.REPEAT);
      default: return unsupported(`${info.title} behaviors cannot be translated`);
    }
  }

  modMorph(info, refs, depth) {
    if (refs.length < 2) return unsupported('Mod-morph needs two bindings');
    const normal = this.binding(refs[0], depth + 1);
    const morphed = this.binding(refs[1], depth + 1);
    if (normal.status === 'unsupported') return normal;
    const mods = (propTokens(info.node, 'mods') || []).join('|').replace(/[()\s]/g, '').split('|').filter(Boolean);
    const BIT = { MOD_LCTL: 1, MOD_LSFT: 2, MOD_LALT: 4, MOD_LGUI: 8, MOD_RCTL: 16, MOD_RSFT: 32, MOD_RALT: 64, MOD_RGUI: 128 };
    let mask = 0; for (const m of mods) mask |= BIT[m] || 0;
    const plain = (c) => c > 1 && c <= 0x1FFF;
    const isMacro = (c) => c >= QK.MACRO && c < QK.MACRO + this.macros.length;
    if (mask && isMacro(normal.code) && isMacro(morphed.code)) return this.macroMorph(info, normal.code, morphed.code, mask);
    if (!mask || !plain(normal.code) || !plain(morphed.code) || morphed.status === 'unsupported') {
      return approx(normal.code, `Mod-morph "${info.name}" cannot be expressed in Vial; the key always sends ${this.name(normal.code)}`);
    }
    const key = `${normal.code}:${mask}`;
    const layerBit = 1 << this.layerCtx;
    if (this.overrideKeys.has(key)) {
      this.overrideKeys.get(key).layers |= layerBit;
    } else if (this.overrides.length < this.cap.keyOverrides) {
      const entry = { trigger: this.name(normal.code), replacement: this.name(morphed.code), layers: layerBit, trigger_mods: mask, negative_mod_mask: 0, suppressed_mods: mask, options: 0x87 };
      this.overrideKeys.set(key, entry); this.overrides.push(entry);
    } else return approx(normal.code, 'No room for another key override');
    return { code: normal.code, status: 'ok', note: `Key override: with the modifier held it sends ${this.name(morphed.code)}` };
  }

  // A mod-morph between two macros. Stock Vial firmware cannot pick a macro by modifier: it sends a macro key
  // before it looks at key overrides, so an entry with a macro as its trigger does nothing there. The vial_custom
  // firmware (see README) reads that same entry when the macro key goes down, and runs the second macro with the
  // modifiers held back. The key gets a macro of its own, a copy of the first one, so that the rule does not
  // reach other keys that run the first macro. On stock firmware the copy is all that runs.
  macroMorph(info, first, second, mask) {
    const stock = `the key always runs "${this.macroNames[first - QK.MACRO]}"`;
    let own = this.morphMacros.get(info.name);
    if (!own) {
      if (this.macros.length >= this.cap.macros) return approx(first, `Mod-morph "${info.name}": no room for another macro; ${stock}`);
      if (this.overrides.length >= this.cap.keyOverrides) return approx(first, `Mod-morph "${info.name}": no room for another key override; ${stock}`);
      const code = QK.MACRO + this.macros.length;
      this.macros.push(this.macros[first - QK.MACRO].map((action) => [...action]));
      this.macroNames.push(info.name);
      const entry = { trigger: this.name(code), replacement: this.name(second), layers: 0, trigger_mods: mask, negative_mod_mask: 0, suppressed_mods: mask, options: 0x87 };
      this.overrides.push(entry);
      own = { code, entry };
      this.morphMacros.set(info.name, own);
    }
    own.entry.layers |= 1 << this.layerCtx;
    return approx(own.code, `With the modifier held it runs "${this.macroNames[second - QK.MACRO]}" (${this.name(second)}), on the vial_custom firmware only; on stock firmware ${stock}`);
  }

  // ---------- macros ----------

  macro(info) {
    if (this.macroIdx.has(info.name)) return this.macroIdx.get(info.name);
    if (this.macros.length >= this.cap.macros) return { error: `More than ${this.cap.macros} macros are needed` };
    const slot = { n: this.macros.length, status: 'ok', note: undefined };
    this.macroIdx.set(info.name, slot);
    this.macros.push([]); this.macroNames.push(info.name);
    const node = info.node;
    const steps = parseBindings(propTokens(node, 'bindings'));
    const waitProp = propTokens(node, 'wait-ms');
    let wait = waitProp ? Number(waitProp[0]) : null;
    const mode = this.opts.macroDelays;
    let kind = 'tap';
    const actions = [];
    const notes = [];
    const push = (tag, name) => {
      const last = actions[actions.length - 1];
      const delay = mode === 'always' ? (wait ?? 15) : mode === 'explicit' ? wait : null;
      if (last && delay) actions.push(['delay', delay]);
      const prev = actions[actions.length - 1];
      if (prev && prev[0] === tag && !delay) prev.push(name); else actions.push([tag, name]);
    };
    for (const s of steps) {
      if (s.behavior === 'macro_tap') { kind = 'tap'; continue; }
      if (s.behavior === 'macro_press') { kind = 'down'; continue; }
      if (s.behavior === 'macro_release') { kind = 'up'; continue; }
      if (s.behavior === 'macro_wait_time') { wait = Number(s.params[0]) || 0; continue; }
      if (s.behavior === 'macro_tap_time') continue;
      if (s.behavior === 'macro_pause_for_release') { notes.push('"pause for release" is not available; the macro runs straight through'); continue; }
      if (/^macro_param_/.test(s.behavior)) { notes.push('macro parameters are not available'); continue; }
      const r = this.binding(s, 1);
      if (r.status === 'unsupported') { notes.push(r.note || `&${s.behavior} skipped`); continue; }
      if (r.note && r.status === 'approx') notes.push(r.note);
      // The firmware sends plain keys straight to the computer, but runs every other key of a macro as a key
      // press of its own (vial_keycode_down). When the macro key was waiting behind a hold-tap key, that inner
      // key press starts the waiting macro key again, and so on without end. Read from the firmware source.
      if (r.code > 0x1FFF) notes.push(`it presses ${this.name(r.code)}, which is not a plain key: pressed right after a hold-tap key, this macro can make the keyboard stop responding until it is unplugged`);
      push(kind, this.name(r.code));
    }
    this.macros[slot.n] = actions;
    if (notes.length) {
      slot.status = 'approx'; slot.note = [...new Set(notes)].join('; ');
      this.issue('warn', { macro: info.name }, `Macro "${info.name}": ${slot.note}`);
    }
    return slot;
  }

  // ---------- whole keymap ----------

  run() {
    const { km, target } = this;
    const layers = km.layers;
    const out = {
      target, keys: [], encoders: [], macros: this.macros, macroNames: this.macroNames, tapDance: [], combos: [], comboNames: [],
      keyOverrides: this.overrides, settings: {}, settingsInfo: [], issues: this.issues, layoutOptions: this.opts.layoutOptions ?? 0,
    };
    if (km.keyCount !== target.positions.length) {
      this.issue('error', {}, `This keymap has ${km.keyCount} keys but the ${target.name} has ${target.positions.length}; the layouts do not line up.`);
    }
    if (layers.length > target.layers) this.issue('error', {}, `The keymap has ${layers.length} layers; the keyboard holds ${target.layers}.`);

    // give macros stable numbers: file order
    for (const m of km.macros) if (m.compatible === 'zmk,behavior-macro' && this.macros.length < this.cap.macros) this.macro(m);

    layers.slice(0, target.layers).forEach((layer, li) => {
      this.layerCtx = li;
      const row = [];
      for (let pos = 0; pos < target.positions.length; pos++) {
        const b = layer.bindings[pos];
        const source = b ? bindingText(b) : '';
        const ov = this.opts.overrides[`${li}:${pos}`];
        let r;
        if (ov) {
          try { r = { code: this.qmk.decode(ov), status: 'override', note: 'Set by hand for this keyboard' }; }
          catch (e) { r = unsupported(`Override "${ov}": ${e.message}`); }
        } else r = b ? this.binding(b) : ok(QK.TRNS);
        row.push({ code: r.code, status: r.status, note: r.note, name: this.name(r.code), source });
        if ((r.status === 'unsupported' || r.status === 'approx') && !r.reported) {
          this.issue(r.status === 'unsupported' ? 'unsupported' : 'warn', { layer: li, pos }, `${layer.label} key ${pos}, ${source}: ${r.note || 'not translated'}`);
        }
      }
      out.keys.push(row);

      // encoders: [counter-clockwise, clockwise] per encoder
      const enc = [];
      for (let e = 0; e < (target.encoders || 0); e++) {
        const sb = layer.sensorBindings ? layer.sensorBindings[e] : null;
        let cw = ok(QK.TRNS); let ccw = ok(QK.TRNS);
        if (sb) {
          const info = km.behavior(sb.behavior);
          if (sb.behavior === 'inc_dec_kp') { cw = this.key(sb.params[0] || ''); ccw = this.key(sb.params[1] || ''); }
          else if (info.custom && info.compatible === 'zmk,behavior-sensor-rotate') {
            const rb = parseBindings(propTokens(info.node, 'bindings'));
            cw = rb[0] ? this.binding(rb[0], 1) : ok(QK.NO); ccw = rb[1] ? this.binding(rb[1], 1) : ok(QK.NO);
          } else if (info.custom && info.compatible === 'zmk,behavior-sensor-rotate-var') {
            const rb = parseBindings(propTokens(info.node, 'bindings'));
            cw = this.binding({ behavior: (rb[0] || {}).behavior || 'kp', params: [sb.params[0]] }, 1);
            ccw = this.binding({ behavior: (rb[1] || {}).behavior || 'kp', params: [sb.params[1]] }, 1);
          } else { cw = unsupported('Unknown encoder behavior'); ccw = cw; }
          for (const r of [cw, ccw]) if (r.status === 'unsupported') this.issue('warn', { layer: li, encoder: e }, `${layer.label} encoder ${e + 1}: ${r.note}`);
        }
        const pair = this.opts.swapEncoders ? [cw, ccw] : [ccw, cw];
        enc.push(pair.map((r) => ({ ...r, name: this.name(r.code) })));
      }
      out.encoders.push(enc);
    });

    this.combos(out);
    out.tapDance = this.tapDances.map((e) => [...e.slice(0, 4).map((c) => this.name(c)), e[4]]);
    this.settings(out);

    const flat = out.keys.flat();
    out.summary = {
      total: flat.length,
      ok: flat.filter((k) => k.status === 'ok' || k.status === 'override').length,
      approx: flat.filter((k) => k.status === 'approx').length,
      unsupported: flat.filter((k) => k.status === 'unsupported').length,
    };
    return out;
  }

  combos(out) {
    const { km } = this;
    for (const c of km.combos) {
      const where = { combo: c.name };
      const b = c.bindings[0];
      if (!b) continue;
      this.layerCtx = 0;
      const r = this.binding(b);
      if (r.status === 'unsupported') {
        this.issue(WIRELESS[b.behavior] ? 'info' : 'warn', where, `Combo "${c.name}" (${bindingText(b)}) is left out: ${r.note}`);
        continue;
      }
      if (c.keyPositions.length > 4) { this.issue('warn', where, `Combo "${c.name}" uses ${c.keyPositions.length} keys; Vial combos take at most 4.`); continue; }
      const ref = c.layers.length ? (km.resolveLayer(c.layers[0]) ?? 0) : 0;
      const row = out.keys[ref] || out.keys[0] || [];
      const inputs = c.keyPositions.map((p) => row[p]);
      if (inputs.some((k) => !k || k.code <= 1 || k.status === 'unsupported')) {
        this.issue('warn', where, `Combo "${c.name}" is left out: one of its keys has no keycode on layer ${ref}.`);
        continue;
      }
      if (new Set(inputs.map((k) => k.code)).size !== inputs.length) { this.issue('warn', where, `Combo "${c.name}" is left out: two of its keys send the same keycode.`); continue; }
      if (out.combos.length >= this.cap.combos) { this.issue('warn', where, `Combo "${c.name}" is left out: no room for more than ${this.cap.combos} combos.`); continue; }
      const entry = inputs.map((k) => k.name);
      while (entry.length < 4) entry.push('KC_NO');
      entry.push(this.name(r.code));
      out.combos.push(entry); out.comboNames.push(c.name);
      if (c.layers.length > 1 || (c.layers.length === 1 && km.layerNodes.length > 1)) {
        this.issue('info', where, `Combo "${c.name}": Vial combos follow keycodes, not layers, so it fires on any layer where those keys send the same keycodes.`);
      }
    }
  }

  // Global tap-hold settings taken from the hold-tap behavior used most.
  settings(out) {
    const { km } = this;
    const use = new Map();
    for (const layer of km.layers) for (const b of layer.bindings) {
      const info = km.behavior(b.behavior);
      if (info.custom && info.compatible === 'zmk,behavior-hold-tap') {
        const refs = parseBindings(propTokens(info.node, 'bindings'));
        if (refs[0] && refs[0].behavior === 'kp' && refs[1] && refs[1].behavior === 'kp') use.set(info, (use.get(info) || 0) + 1);
      }
    }
    const info = [];
    const top = [...use.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) {
      const node = top[0].node; const name = top[0].name;
      const int = (p) => { const t = propTokens(node, p); return t && /^\d+$/.test(t[0]) ? Number(t[0]) : null; };
      const flavor = propString(node, 'flavor') || 'hold-preferred';
      const from = `&${name}`;
      info.push({ qsid: 7, title: 'Tapping term (ms)', value: int('tapping-term-ms') ?? 200, from });
      info.push({ qsid: 22, title: 'Permissive hold', value: flavor === 'balanced' ? 1 : 0, from: `${from} flavor "${flavor}"` });
      info.push({ qsid: 23, title: 'Hold on other key press', value: flavor === 'hold-preferred' ? 1 : 0, from: `${from} flavor "${flavor}"` });
      info.push({ qsid: 24, title: 'Retro tapping', value: getProp(node, 'retro-tap') ? 1 : 0, from });
      if (int('quick-tap-ms') !== null) info.push({ qsid: 25, title: 'Quick tap term (ms)', value: int('quick-tap-ms'), from });
      if (int('require-prior-idle-ms') !== null) info.push({ qsid: 27, title: 'Flow tap (ms)', value: int('require-prior-idle-ms'), from: `${from} require-prior-idle-ms`, newer: true });
      const trig = (propTokens(node, 'hold-trigger-key-positions') || []).filter((t) => /^\d+$/.test(t)).map(Number);
      if (trig.length && km.layout) {
        // QMK's chordal hold means "hold only together with the other hand". Use it only if that is what the ZMK rule says.
        const xs = km.layout.map((k) => k.x + (k.w || 1) / 2);
        const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
        const side = (pos) => (xs[pos] < mid ? 'L' : 'R');
        const own = new Set();
        km.layers.forEach((l) => l.bindings.forEach((b, pos) => { if (b.behavior === name) own.add(side(pos)); }));
        const opposite = own.size === 1 && trig.every((pos) => xs[pos] !== undefined && side(pos) !== [...own][0]);
        if (opposite) info.push({ qsid: 26, title: 'Chordal hold (opposite hands)', value: 1, from: `${from} hold-trigger-key-positions`, newer: true });
        else this.issue('info', {}, `&${name} limits holds to certain key positions (hold-trigger-key-positions). QMK has no matching rule here, so on this keyboard another key pressed within the tapping term does not force a tap.`);
      }
      if (use.size > 1) this.issue('info', {}, `QMK has one set of tap-hold timings for the whole keyboard. They are taken from &${name}; other hold-taps (${[...use.keys()].filter((k) => k !== top[0]).map((k) => '&' + k.name).join(', ')}) share them.`);
    }
    const sticky = km.behaviors.filter((b) => b.compatible === 'zmk,behavior-sticky-key');
    const rel = sticky.map((b) => propTokens(b.node, 'release-after-ms')).filter(Boolean).map((t) => Number(t[0])).filter((n) => n > 0);
    if (rel.length) info.push({ qsid: 6, title: 'One-shot timeout (ms)', value: Math.min(...rel), from: '&' + sticky[0].name });
    const comboTimeouts = km.combos.map((c) => c.timeoutMs).filter((n) => typeof n === 'number');
    if (comboTimeouts.length) info.push({ qsid: 2, title: 'Combo timeout (ms)', value: Math.max(...comboTimeouts), from: 'combos' });
    const skip = new Set(this.opts.skipSettings || []);
    for (const s of info) { s.enabled = this.opts.applySettings && !skip.has(s.qsid); if (s.enabled) out.settings[s.qsid] = s.value; }
    out.settingsInfo = info;
  }
}
