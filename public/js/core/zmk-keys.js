// ZMK key names: lookup, modifier wrappers like LS(LG(X)), and short keycap labels.

export const MOD_FN = { LC: 0x01, LS: 0x02, LA: 0x04, LG: 0x08, RC: 0x10, RS: 0x20, RA: 0x40, RG: 0x80 };
export const MOD_ORDER = ['LC', 'LS', 'LA', 'LG', 'RC', 'RS', 'RA', 'RG'];
export const MOD_SYMBOL = { LC: '⌃', LS: '⇧', LA: '⌥', LG: '⌘', RC: '⌃', RS: '⇧', RA: '⌥', RG: '⌘' };
export const MOD_TITLE = {
  LC: 'Left Control', LS: 'Left Shift', LA: 'Left Alt / Option', LG: 'Left GUI / Command',
  RC: 'Right Control', RS: 'Right Shift', RA: 'Right Alt / AltGr', RG: 'Right GUI / Command',
};

const SPECIAL_LABELS = {
  '7:40': '⏎', '7:41': 'Esc', '7:42': '⌫', '7:43': '⇥', '7:44': '␣', '7:57': 'Caps', '7:76': '⌦',
  '7:79': '→', '7:80': '←', '7:81': '↓', '7:82': '↑', '7:74': 'Home', '7:77': 'End', '7:75': 'PgUp', '7:78': 'PgDn',
  '7:73': 'Ins', '7:70': 'PrtSc', '7:71': 'ScrLk', '7:72': 'Pause', '7:83': 'NumLk', '7:101': 'Menu',
  '7:224': '⌃', '7:225': '⇧', '7:226': '⌥', '7:227': '⌘', '7:228': '⌃', '7:229': '⇧', '7:230': '⌥', '7:231': '⌘',
  '7:88': 'KP ⏎', '7:127': 'Mute', '7:128': 'Vol+', '7:129': 'Vol−',
  '12:233': 'Vol+', '12:234': 'Vol−', '12:226': 'Mute', '12:205': '⏯', '12:181': '⏭', '12:182': '⏮', '12:183': '⏹',
  '12:111': '☀+', '12:112': '☀−', '12:179': '⏩', '12:180': '⏪', '12:184': '⏏', '12:669': '🌐',
  '1:129': 'Power', '1:130': 'Sleep', '1:131': 'Wake',
};
const SIDE = { 224: 'L', 225: 'L', 226: 'L', 227: 'L', 228: 'R', 229: 'R', 230: 'R', 231: 'R' };

export class ZmkKeys {
  constructor(entries) {
    this.entries = entries;
    this.byName = new Map();
    this.byUsage = new Map();
    for (const e of entries) {
      for (const nm of e.names) this.byName.set(nm, e);
      const k = `${e.page}:${e.id}:${e.mods}`;
      if (!this.byUsage.has(k)) this.byUsage.set(k, e);
      e.label = makeLabel(e);
      e.search = (e.names.join(' ') + ' ' + e.desc).toLowerCase();
    }
  }

  get(name) { return this.byName.get(name); }

  // "LS(LG(X))" -> { mods: ['LS','LG'], name: 'X', entry, modBits }   (entry undefined when the name is unknown)
  parse(expr) {
    let s = String(expr).trim();
    const mods = [];
    for (;;) {
      const m = /^(LC|LS|LA|LG|RC|RS|RA|RG)\((.*)\)$/s.exec(s);
      if (m) { if (!mods.includes(m[1])) mods.push(m[1]); s = m[2].trim(); continue; }
      const p = /^\((.*)\)$/s.exec(s);
      if (p) { s = p[1].trim(); continue; }
      break;
    }
    const entry = this.byName.get(s);
    let modBits = 0;
    for (const m of mods) modBits |= MOD_FN[m];
    return { mods, name: s, entry, modBits };
  }

  build(name, mods) {
    let s = name;
    for (const m of MOD_ORDER.filter((x) => mods.includes(x)).reverse()) s = `${m}(${s})`;
    return s;
  }

  // HID usage with all modifiers applied: { page, id, mods } or null
  resolve(expr) {
    const p = this.parse(expr);
    if (!p.entry) return null;
    return { page: p.entry.page, id: p.entry.id, mods: p.entry.mods | p.modBits };
  }

  // Short text for a keycap.
  label(expr) {
    const p = this.parse(expr);
    const base = p.entry ? p.entry.label : p.name;
    if (!p.mods.length) return base;
    return p.mods.map((m) => MOD_SYMBOL[m]).join('') + ' ' + base;
  }

  describe(expr) {
    const p = this.parse(expr);
    const base = p.entry ? p.entry.desc.replace(/^Keyboard /, '') : p.name;
    return [...p.mods.map((m) => MOD_TITLE[m]), base].join(' + ');
  }

  isModifier(expr) {
    const p = this.parse(expr);
    return !!p.entry && p.entry.page === 7 && p.entry.id >= 224 && p.entry.id <= 231 && !p.mods.length;
  }

  search(query, limit = 80) {
    const q = query.trim().toLowerCase();
    if (!q) return this.entries.slice(0, limit);
    const exact = []; const starts = []; const rest = [];
    for (const e of this.entries) {
      const names = e.names.map((x) => x.toLowerCase());
      if (names.includes(q) || e.label.toLowerCase() === q) exact.push(e);
      else if (names.some((x) => x.startsWith(q))) starts.push(e);
      else if (q.split(/\s+/).every((w) => e.search.includes(w))) rest.push(e);
    }
    return [...exact, ...starts, ...rest].slice(0, limit);
  }
}

function makeLabel(e) {
  const key = `${e.page}:${e.id}`;
  if (!e.mods && SPECIAL_LABELS[key]) {
    const s = SPECIAL_LABELS[key];
    return e.page === 7 && SIDE[e.id] && e.id >= 228 ? 'R' + s : s;
  }
  let m = /^Keyboard (\S)(?: and \S)?(?: \(|$)/.exec(e.desc);
  if (m) return m[1].toUpperCase();
  m = /^Keyboard (\S) and (\S) /.exec(e.desc);
  if (m) return m[1].toUpperCase();
  m = /^Keypad (\S)(?: |$)/.exec(e.desc);
  if (m) return 'KP ' + m[1];
  m = /^Keyboard (F\d+)$/.exec(e.desc);
  if (m) return m[1];
  // shortest non-deprecated name
  const dep = new Set(e.deprecated || []);
  const names = e.names.filter((x) => !dep.has(x));
  return names.reduce((a, b) => (b.length < a.length ? b : a), names[0] || e.names[0]);
}
