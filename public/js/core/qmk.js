// QMK / Vial keycodes: numbers, the names Vial uses in .vil files, and a decoder for typed-in names.
// The tables come from vial-gui (keycodes_v6.py), so names match what Vial itself reads and writes.

const MOD_FN = {
  LCTL: 0x0100, LSFT: 0x0200, LALT: 0x0400, LGUI: 0x0800, RCTL: 0x1100, RSFT: 0x1200, RALT: 0x1400, RGUI: 0x1800,
  LOPT: 0x0400, LCMD: 0x0800, LWIN: 0x0800, ALGR: 0x1400, ROPT: 0x1400, RCMD: 0x1800, RWIN: 0x1800,
  C: 0x0100, S: 0x0200, A: 0x0400, G: 0x0800,
  HYPR: 0x0F00, MEH: 0x0700, LCAG: 0x0D00, SGUI: 0x0A00, SCMD: 0x0A00, SWIN: 0x0A00, LSG: 0x0A00, C_S: 0x0300, LCS: 0x0300,
  LCA: 0x0500, LSA: 0x0600, LAG: 0x0C00, RSA: 0x1600, RCS: 0x1300, SAGR: 0x1600, LCG: 0x0900, RCG: 0x1900,
};
const MOD_NAMES = { MOD_LCTL: 0x01, MOD_LSFT: 0x02, MOD_LALT: 0x04, MOD_LGUI: 0x08, MOD_RCTL: 0x11, MOD_RSFT: 0x12, MOD_RALT: 0x14, MOD_RGUI: 0x18, MOD_HYPR: 0x0F, MOD_MEH: 0x07 };
const SINGLE_MODS = [[0x01, 'CTL'], [0x02, 'SFT'], [0x04, 'ALT'], [0x08, 'GUI']];

export const QK = {
  NO: 0x0000, TRNS: 0x0001, MOD_TAP: 0x2000, LAYER_TAP: 0x4000, TO: 0x5200, MOMENTARY: 0x5220, DEF_LAYER: 0x5240,
  TOGGLE_LAYER: 0x5260, ONE_SHOT_LAYER: 0x5280, ONE_SHOT_MOD: 0x52A0, LAYER_TAP_TOGGLE: 0x52C0, TAP_DANCE: 0x5700, MACRO: 0x7700,
  BOOT: 0x7C00, REBOOT: 0x7C01, GESC: 0x7C16, CAPS_WORD: 0x7C73, REPEAT: 0x7C79,
};

export class Qmk {
  constructor(data) {
    if (data.protocol !== 6) throw new Error('Only Vial protocol 6 keycodes are bundled.');
    this.labels = data.labels;
    this.byName = new Map();
    this.nameOf = new Map();
    this.masked = new Set();
    const add = (name, code, registered) => {
      this.byName.set(name, code);
      if (!registered) return;
      if (name.endsWith('(kc)')) this.masked.add(code);
      this.nameOf.set(code, name); // later names win, as in Vial's RAWCODES_MAP
    };
    for (const [name, code] of Object.entries(data.codes)) add(name, code, !!data.labels[name]);
    for (let x = 0; x < 256; x++) { add(`M${x}`, QK.MACRO + x, true); add(`TD(${x})`, QK.TAP_DANCE + x, true); }
    for (let x = 0; x < 32; x++) {
      add(`MO(${x})`, QK.MOMENTARY + x, true); add(`DF(${x})`, QK.DEF_LAYER + x, true); add(`TG(${x})`, QK.TOGGLE_LAYER + x, true);
      add(`TT(${x})`, QK.LAYER_TAP_TOGGLE + x, true); add(`OSL(${x})`, QK.ONE_SHOT_LAYER + x, true); add(`TO(${x})`, QK.TO + x, true);
      add(`PDF(${x})`, 0x52E0 + x, true);
    }
    for (let x = 0; x < 16; x++) add(`LT${x}(kc)`, QK.LAYER_TAP | (x << 8), true);
    for (const [alias, name] of Object.entries(data.aliases)) if (this.byName.has(name) && !this.byName.has(alias)) this.byName.set(alias, this.byName.get(name));
    for (const [k, v] of Object.entries(MOD_NAMES)) this.byName.set(k, v);
    this.byName.set('XXXXXXX', 0); this.byName.set('_______', 1);
  }

  // ---- building keycodes ----
  // mod5: ctl=1 sft=2 alt=4 gui=8, +0x10 for right-hand
  static mod5From8(m8) {
    const left = m8 & 0x0F; const right = (m8 >> 4) & 0x0F;
    if (!right) return { mod5: left, mixed: false, altFlipped: false };
    // QMK has one "right hand" flag for all modifiers of a key. Flipping Shift/Ctrl/GUI to the right side is harmless;
    // flipping left Alt turns it into AltGr, which is a real change.
    return { mod5: 0x10 | left | right, mixed: left !== 0, altFlipped: (left & 0x04) !== 0 && (right & 0x04) === 0 };
  }
  withMods(kc, mod5) { return mod5 ? ((mod5 & 0x1F) << 8) | (kc & 0xFF) : kc; }
  modTap(mod5, kc) { return QK.MOD_TAP | ((mod5 & 0x1F) << 8) | (kc & 0xFF); }
  layerTap(layer, kc) { return QK.LAYER_TAP | ((layer & 0xF) << 8) | (kc & 0xFF); }
  osm(mod5) { return QK.ONE_SHOT_MOD | (mod5 & 0x1F); }

  // ---- number -> name (same rules as Vial's Keycode.serialize, plus spelled-out forms for unusual modifier mixes) ----
  serialize(code) {
    if (typeof code === 'string') return code;
    const hi = code & 0xFF00;
    if (!this.masked.has(hi)) {
      const n = this.nameOf.get(code);
      if (n) return n;
    } else {
      const outer = this.nameOf.get(hi); const inner = this.nameOf.get(code & 0xFF);
      if (outer && inner) return outer.replace('kc', inner);
    }
    const inner = this.nameOf.get(code & 0xFF);
    const modBits = (code >> 8) & 0x0F;
    if (code >= 0x0100 && code <= 0x1FFF && inner && modBits) {
      const side = code & 0x1000 ? 'R' : 'L';
      let s = inner;
      for (const [bit, nm] of [...SINGLE_MODS].reverse()) if ((code >> 8) & bit) s = `${side}${nm}(${s})`;
      return s;
    }
    if (code >= 0x2000 && code <= 0x3FFF && inner && modBits) {
      const side = code & 0x1000 ? 'R' : 'L';
      const mods = SINGLE_MODS.filter(([bit]) => (code >> 8) & bit).map(([, nm]) => `MOD_${side}${nm}`);
      return `MT(${mods.join('|')}, ${inner})`;
    }
    if (code >= QK.ONE_SHOT_MOD && code <= QK.ONE_SHOT_MOD + 0x1F && (code & 0x0F)) {
      const side = code & 0x10 ? 'R' : 'L';
      return `OSM(${SINGLE_MODS.filter(([bit]) => code & bit).map(([, nm]) => `MOD_${side}${nm}`).join('|')})`;
    }
    return '0x' + code.toString(16);
  }

  // ---- name -> number. Accepts everything Vial accepts in its "Any" key box. Throws on unknown names. ----
  decode(input) {
    const s = String(input).trim();
    if (this.byName.has(s)) return this.byName.get(s);
    let i = 0;
    const ws = () => { while (/\s/.test(s[i] || '')) i++; };
    const expr = () => { let v = term(); ws(); while (s[i] === '|') { i++; v |= term(); ws(); } return v; };
    const term = () => {
      ws();
      if (s[i] === '(') { i++; const v = expr(); ws(); if (s[i] !== ')') throw new Error('Missing ")"'); i++; return v; }
      const num = /^(0x[0-9a-fA-F]+|\d+)/.exec(s.slice(i));
      if (num) { i += num[0].length; return Number(num[0]); }
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      if (!id) throw new Error(`Cannot read "${s}"`);
      i += id[0].length; ws();
      if (s[i] !== '(') {
        if (!this.byName.has(id[0])) throw new Error(`Unknown keycode "${id[0]}"`);
        return this.byName.get(id[0]);
      }
      i++;
      const args = [];
      ws();
      if (s[i] !== ')') { for (;;) { args.push(expr()); ws(); if (s[i] === ',') { i++; continue; } break; } }
      if (s[i] !== ')') throw new Error('Missing ")"');
      i++;
      return this.call(id[0], args);
    };
    const v = expr(); ws();
    if (i < s.length) throw new Error(`Unexpected "${s.slice(i)}"`);
    return v & 0xFFFF;
  }

  call(fn, a) {
    const need = (n) => { if (a.length !== n) throw new Error(`${fn} takes ${n} argument${n > 1 ? 's' : ''}`); };
    if (MOD_FN[fn] !== undefined) { need(1); return MOD_FN[fn] | a[0]; }
    if (fn.endsWith('_T')) {
      const base = fn.slice(0, -2);
      const table = { CTL: 'LCTL', SFT: 'LSFT', ALT: 'LALT', OPT: 'LALT', GUI: 'LGUI', CMD: 'LGUI', WIN: 'LGUI', ALL: 'HYPR' };
      const m = MOD_FN[table[base] || base];
      if (m !== undefined) { need(1); return QK.MOD_TAP | ((m >> 8) << 8) | (a[0] & 0xFF); }
    }
    const lt = /^LT(\d+)$/.exec(fn);
    if (lt) { need(1); return this.layerTap(Number(lt[1]), a[0]); }
    switch (fn) {
      case 'LT': need(2); return this.layerTap(a[0], a[1]);
      case 'MT': need(2); return this.modTap(a[0], a[1]);
      case 'MO': need(1); return QK.MOMENTARY | (a[0] & 0x1F);
      case 'TO': need(1); return QK.TO | (a[0] & 0x1F);
      case 'DF': need(1); return QK.DEF_LAYER | (a[0] & 0x1F);
      case 'TG': need(1); return QK.TOGGLE_LAYER | (a[0] & 0x1F);
      case 'TT': need(1); return QK.LAYER_TAP_TOGGLE | (a[0] & 0x1F);
      case 'OSL': need(1); return QK.ONE_SHOT_LAYER | (a[0] & 0x1F);
      case 'OSM': need(1); return QK.ONE_SHOT_MOD | (a[0] & 0x1F);
      case 'LM': need(2); return 0x5000 | ((a[0] & 0xF) << 5) | (a[1] & 0x1F);
      case 'TD': need(1); return QK.TAP_DANCE | (a[0] & 0xFF);
      default: throw new Error(`Unknown function "${fn}"`);
    }
  }

  // Two-part keycap text: { top, main }
  legend(codeOrName) {
    const name = this.serialize(typeof codeOrName === 'number' ? codeOrName : this.decodeSafe(codeOrName));
    if (name === 'KC_NO') return { top: '', main: '' };
    const m = /^([A-Za-z0-9_]+)\((.*)\)$/.exec(name);
    const short = (n) => {
      const l = this.labels[n];
      if (!l) return n.replace(/^KC_/, '');
      const lines = l.label.split('\n');
      return lines.length === 2 && lines[0].length === 1 && lines[1].length === 1 ? lines[1] : lines.join(' ');
    };
    if (m && this.byName.has(m[1] + '(kc)')) return { top: m[1], main: short(m[2]) };
    if (m && this.labels[name]) return { top: '', main: this.labels[name].label.replace(/\n/g, ' ') };
    if (m) return { top: m[1], main: m[2].replace(/KC_|MOD_/g, '') };
    return { top: '', main: short(name) };
  }

  decodeSafe(name) { try { return this.decode(name); } catch { return name; } }
}
