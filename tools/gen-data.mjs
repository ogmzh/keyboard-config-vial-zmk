// Regenerates the key tables in public/data from upstream sources.
// Usage: node tools/gen-data.mjs <zmk-repo> <vial-gui-repo>
// Reads the upstream files as text only (nothing from them is executed).
import fs from 'node:fs';
import path from 'node:path';

const [zmkDir, vialDir] = process.argv.slice(2);
if (!zmkDir || !vialDir) { console.error('usage: gen-data.mjs <zmk> <vial-gui>'); process.exit(1); }
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'data');

// ---------- ZMK keys (app/include/dt-bindings/zmk/keys.h, MIT) ----------
const inc = (f) => fs.readFileSync(path.join(zmkDir, 'app/include/dt-bindings/zmk', f), 'utf8');
const consts = {};
for (const f of ['hid_usage.h', 'hid_usage_pages.h']) {
  for (const m of inc(f).matchAll(/^#define\s+(\w+)\s+\(?(0x[0-9A-Fa-f]+|\d+)\)?/gm)) consts[m[1]] = Number(m[2]);
}
const MODS = { LC: 0x01, LS: 0x02, LA: 0x04, LG: 0x08, RC: 0x10, RS: 0x20, RA: 0x40, RG: 0x80 };
const keysSrc = inc('keys.h').replace(/\\\r?\n/g, ' ');
const byName = new Map();
const entries = [];
let lastComment = '';
for (const line of keysSrc.split(/\r?\n/)) {
  const c = line.match(/^\/\*\s*(.*?)\s*\*\/\s*$/);
  if (c) { lastComment = c[1]; continue; }
  const d = line.match(/^#define\s+(\w+)\s+(.*?)\s*(\/\/.*)?$/);
  if (!d) continue;
  const [, name, exprRaw, trailing] = d;
  const deprecated = /DEPRECATED/.test(trailing || '');
  let expr = exprRaw.trim();
  let mods = 0;
  // unwrap parens and modifier wrappers
  for (;;) {
    const p = expr.match(/^\((.*)\)$/s);
    if (p && balanced(p[1])) { expr = p[1].trim(); continue; }
    const mm = expr.match(/^(LC|LS|LA|LG|RC|RS|RA|RG)\((.*)\)$/s);
    if (mm && balanced(mm[2])) { mods |= MODS[mm[1]]; expr = mm[2].trim(); continue; }
    break;
  }
  const u = expr.match(/^ZMK_HID_USAGE\(\s*(\w+)\s*,\s*(\w+)\s*\)$/);
  if (u) {
    const page = consts[u[1]];
    const id = /^0x|^\d/.test(u[2]) ? Number(u[2]) : consts[u[2]];
    if (page === undefined || id === undefined) { console.warn('unresolved', name, expr); continue; }
    const e = { names: [name], desc: lastComment, page, id, mods, deprecated: deprecated ? [name] : [] };
    entries.push(e); byName.set(name, e);
  } else if (/^\w+$/.test(expr) && byName.has(expr)) {
    const e = byName.get(expr);
    if (mods) { // alias that adds modifiers: make it its own entry
      const n = { names: [name], desc: lastComment, page: e.page, id: e.id, mods: e.mods | mods, deprecated: deprecated ? [name] : [] };
      entries.push(n); byName.set(name, n);
    } else {
      e.names.push(name); if (deprecated) e.deprecated.push(name); byName.set(name, e);
    }
  }
}
function balanced(s) { let d = 0; for (const ch of s) { if (ch === '(') d++; else if (ch === ')') { d--; if (d < 0) return false; } } return d === 0; }
for (const e of entries) if (!e.deprecated.length) delete e.deprecated;
fs.writeFileSync(path.join(outDir, 'zmk-keys.json'), JSON.stringify(entries));
console.log('zmk keys:', entries.length, 'entries,', byName.size, 'names');

// ---------- QMK / Vial keycodes (vial-gui keycodes_v6.py + keycodes.py, GPL-2.0-or-later) ----------
const py = (f) => fs.readFileSync(path.join(vialDir, 'src/main/python/keycodes', f), 'utf8');
const codes = {};
for (const m of py('keycodes_v6.py').matchAll(/^\s*"([^"]+)":\s*(0x[0-9a-fA-F]+|\d+)\s*,?\s*$/gm)) codes[m[1]] = Number(m[2]);
const labels = {};
const aliases = {};
for (const m of py('keycodes.py').matchAll(/\bK\(\s*("(?:[^"\\]|\\.)*"|'"')\s*,\s*("(?:[^"\\]|\\.)*"|'"')(?:\s*,\s*("(?:[^"\\]|\\.)*"))?([^\n]*)/g)) {
  const lit = (s) => (s === `'"'` ? '"' : JSON.parse(s));
  const id = lit(m[1]);
  labels[id] = { label: lit(m[2]) };
  if (m[3]) labels[id].tip = lit(m[3]);
  const al = (m[4] || "").match(/(?<![a-z_])alias=\[([^\]]*)\]/);
  if (al) for (const a of al[1].matchAll(/"([^"]+)"/g)) aliases[a[1]] = id;
}
fs.writeFileSync(path.join(outDir, 'qmk-keycodes.json'), JSON.stringify({ protocol: 6, codes, labels, aliases }));
console.log('qmk codes:', Object.keys(codes).length, 'labels:', Object.keys(labels).length, 'aliases:', Object.keys(aliases).length);

// ---------- Vial target: Keebart Corne MX Pro (from Keebart's vial-qmk fork, optional 3rd argument) ----------
const qmkDir = process.argv[4];
if (qmkDir) {
  const kb = path.join(qmkDir, 'keyboards/keebart/corne_mx_pro');
  const infoJ = JSON.parse(fs.readFileSync(path.join(kb, 'info.json'), 'utf8'));
  const vial = JSON.parse(fs.readFileSync(path.join(kb, 'keymaps/vial/vial.json'), 'utf8'));
  const cfg = fs.readFileSync(path.join(kb, 'keymaps/vial/config.h'), 'utf8');
  const kcfg = fs.readFileSync(path.join(kb, 'config.h'), 'utf8');
  const uidBytes = [...cfg.match(/VIAL_KEYBOARD_UID\s*\{([^}]*)\}/)[1].matchAll(/0x[0-9A-Fa-f]+/g)].map((m) => Number(m[0]));
  let uid = 0n; uidBytes.forEach((b, i) => { uid |= BigInt(b) << BigInt(8 * i); });
  const list = (re) => [...cfg.match(re)[1].matchAll(/\d+/g)].map((m) => Number(m[0]));
  const rows = list(/VIAL_UNLOCK_COMBO_ROWS\s*\{([^}]*)\}/); const cols = list(/VIAL_UNLOCK_COMBO_COLS\s*\{([^}]*)\}/);
  const keys = []; const encoders = new Set();
  for (const row of vial.layouts.keymap) for (const item of row) {
    if (typeof item !== 'string') continue;
    const lab = item.split('\n');
    const [a, b] = lab[0].split(',').map(Number);
    if (lab[9] === 'e') { encoders.add(a); continue; }
    const k = { row: a, col: b };
    if (lab[3]) { const [idx, opt] = lab[3].split(',').map(Number); k.option = [idx, opt]; }
    if (!keys.some((x) => x.row === k.row && x.col === k.col)) keys.push(k);
  }
  const target = {
    id: 'keebart_corne_mx_pro',
    name: 'Keebart Corne MX Pro',
    firmware: 'Vial (QMK)',
    uid: uid.toString(),
    uidBytes,
    vialProtocol: 6,
    viaProtocol: 9,
    matrix: vial.matrix,
    layers: Number(kcfg.match(/DYNAMIC_KEYMAP_LAYER_COUNT\s+(\d+)/)[1]),
    // same order as the ZMK layout: LAYOUT_split_3x6_3_ex2
    positions: infoJ.layouts.LAYOUT_split_3x6_3_ex2.layout.map((k) => k.matrix),
    matrixKeys: keys,
    encoders: encoders.size,
    layoutOptions: vial.layouts.labels.map((l) => ({ label: l[0], choices: l.slice(1) })),
    unlockKeys: rows.map((r, i) => [r, cols[i]]),
    capacity: { macros: 16, tapDance: 32, combos: 32, keyOverrides: 32 },
    // How the keyboard shows up on USB. The 5-column Mini has the same Vial id, so it is told apart by product id.
    usb: {
      vendorId: Number(infoJ.usb.vid),
      productIds: [Number(JSON.parse(fs.readFileSync(path.join(kb, 'standard/keyboard.json'), 'utf8')).usb.pid)],
      miniProductId: Number(JSON.parse(fs.readFileSync(path.join(kb, 'mini/keyboard.json'), 'utf8')).usb.pid),
      product: infoJ.keyboard_name,
      // Seen on a real keyboard (2026-11): product "My Corne MX", product id 0, and the chip's serial number.
      // Same Vial id and the same layout as this source. So the app looks for the vendor and this part of the name.
      vendor: infoJ.manufacturer,
      nameHas: 'Corne MX',
      bootDrive: 'RP2040',
    },
    source: 'github.com/Keebart/vial-qmk-keebart (branch vial) keyboards/keebart/corne_mx_pro',
  };
  // Where the app notes which half this is (see vial-hid.js): the last layer, in the first matrix position
  // of the left thumb row that has no switch. The check below keeps it off every real key.
  target.sideCell = { layer: target.layers - 1, row: 3, col: 0 };
  if (keys.some((k) => k.row === target.sideCell.row && k.col === target.sideCell.col)) throw new Error('The side mark would land on a real key.');
  fs.writeFileSync(path.join(outDir, 'targets', 'corne_mx_pro.json'), JSON.stringify(target, null, 1));
  console.log('target:', target.name, 'uid', target.uid, 'keys', target.positions.length, 'matrix keys', keys.length, 'encoders', target.encoders);
}

// ---------- what Vial's own loader accepts (read from its source text; used by the test suite) ----------
{
  const src = py('keycodes.py');
  const any = fs.readFileSync(path.join(vialDir, 'src/main/python/any_keycode.py'), 'utf8');
  const sections = {};
  for (const m of src.matchAll(/^KEYCODES_(\w+) = \[\n([\s\S]*?)^\]/gm)) {
    const names = [];
    for (const k of m[2].matchAll(/\bK\(\s*"((?:[^"\\]|\\.)*)"([^\n]*)/g)) {
      names.push(k[1]);
      const al = k[2].match(/(?<![a-z_])alias=\[([^\]]*)\]/);
      if (al) for (const a of al[1].matchAll(/"([^"]+)"/g)) names.push(a[1]);
    }
    sections[m[1]] = names;
  }
  const fnBlock = any.match(/^functions = \{([\s\S]*?)^\}/m)[1];
  const functions = [...fnBlock.matchAll(/"(\w+)":/g)].map((m) => m[1]);
  for (let x = 0; x < 16; x++) functions.push(`LT${x}`);
  const anyNames = ['SPECIAL', 'BASIC', 'BASIC_NUMPAD', 'BASIC_NAV', 'SHIFTED', 'ISO', 'ISO_KR', 'BACKLIGHT', 'MEDIA'].flatMap((s) => sections[s] || []);
  anyNames.push('MOD_LCTL', 'MOD_LSFT', 'MOD_LALT', 'MOD_LGUI', 'MOD_RCTL', 'MOD_RSFT', 'MOD_RALT', 'MOD_RGUI', 'MOD_MEH', 'MOD_HYPR');
  const ids = Object.values(sections).flat();
  fs.writeFileSync(path.join(outDir, '..', '..', 'test', 'vial-accepts.json'), JSON.stringify({ ids, functions, anyNames }));
  console.log('vial accepts:', ids.length, 'ids,', functions.length, 'functions,', anyNames.length, 'names usable inside expressions');
}
