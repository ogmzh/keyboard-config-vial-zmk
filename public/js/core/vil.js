// Builds a Vial layout file (.vil) from a translation, in the same shape Vial's own "Save current layout" writes.

import { EMPTY_TAP_DANCE, EMPTY_COMBO, EMPTY_OVERRIDE } from './translate.js';

// tr: result of translate(); state: optional current keyboard state read over USB (keeps what we do not manage)
export function buildVil(tr, { clearUnusedLayers = false, capacity } = {}) {
  const t = tr.target;
  const cap = { ...t.capacity, ...(capacity || {}) };
  const exists = new Set(t.matrixKeys.map((k) => `${k.row},${k.col}`));
  const layerCount = clearUnusedLayers ? t.layers : tr.keys.length;
  const layout = []; const encoderLayout = [];
  for (let l = 0; l < layerCount; l++) {
    const rows = [];
    for (let r = 0; r < t.matrix.rows; r++) {
      const row = [];
      for (let c = 0; c < t.matrix.cols; c++) row.push(exists.has(`${r},${c}`) ? 'KC_TRNS' : -1);
      rows.push(row);
    }
    const keys = tr.keys[l];
    if (keys) t.positions.forEach(([r, c], pos) => { if (keys[pos]) rows[r][c] = keys[pos].name; });
    else for (const row of rows) for (let c = 0; c < row.length; c++) if (row[c] !== -1) row[c] = 'KC_TRNS';
    layout.push(rows);
    const enc = [];
    for (let e = 0; e < (t.encoders || 0); e++) {
      const pair = tr.encoders[l] && tr.encoders[l][e];
      enc.push(pair ? [pair[0].name, pair[1].name] : ['KC_TRNS', 'KC_TRNS']);
    }
    encoderLayout.push(enc);
  }
  const pad = (list, n, empty) => { const out = list.slice(0, n); while (out.length < n) out.push(typeof empty === 'object' && !Array.isArray(empty) ? { ...empty } : [...empty]); return out; };
  const macros = tr.macros.slice(0, cap.macros); while (macros.length < cap.macros) macros.push([]);
  return {
    version: 1,
    uid: '__UID__',
    layout,
    encoder_layout: encoderLayout,
    layout_options: tr.layoutOptions ?? 0,
    macro: macros,
    vial_protocol: t.vialProtocol,
    via_protocol: t.viaProtocol,
    tap_dance: pad(tr.tapDance, cap.tapDance, EMPTY_TAP_DANCE),
    combo: pad(tr.combos, cap.combos, EMPTY_COMBO),
    key_override: pad(tr.keyOverrides, cap.keyOverrides, EMPTY_OVERRIDE),
    alt_repeat_key: [],
    settings: Object.fromEntries(Object.entries(tr.settings).map(([k, v]) => [String(k), v])),
  };
}

// The keyboard id is a 64-bit number, larger than JavaScript can hold exactly, so it is written into the text by hand.
export function vilToText(vil, uid) {
  return JSON.stringify(vil).replace('"__UID__"', String(uid));
}

// Packs the per-option choices (e.g. [0,0,0,0]) the way Vial stores them: first option in the highest bits.
export function packLayoutOptions(choices, options) {
  let value = 0;
  options.forEach((opt, i) => {
    const bits = Math.max(1, Math.ceil(Math.log2(opt.choices.length)));
    value = (value << bits) | ((choices[i] || 0) & ((1 << bits) - 1));
  });
  return value >>> 0;
}

// ---- macros as bytes (Vial protocol 2 and later; two-byte keycodes need protocol 5) ----
export function serializeMacro(actions, qmk) {
  const out = [];
  for (const act of actions) {
    const [tag, ...args] = act;
    if (tag === 'text') { for (const ch of new TextEncoder().encode(args[0])) out.push(ch); continue; }
    if (tag === 'delay') { const d = args[0] | 0; out.push(1, 4, (d % 255) + 1, Math.floor(d / 255) + 1); continue; }
    const base = { tap: 1, down: 2, up: 3 }[tag];
    if (!base) continue;
    for (const name of args) {
      let kc = qmk.decode(name);
      out.push(1);
      if (kc < 256) out.push(base, kc);
      else {
        if (kc % 256 === 0) kc = 0xFF00 | (kc >> 8);
        out.push(base + 4, kc & 0xFF, kc >> 8);
      }
    }
  }
  return out;
}

export function serializeMacros(macros, count, qmk) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const one = serializeMacro(macros[i] || [], qmk);
    // A zero byte ends a macro on the keyboard. One inside a macro would cut it short and shift every macro after it.
    if (one.some((b) => !Number.isInteger(b) || b < 1 || b > 255)) throw new Error(`Macro M${i} cannot be stored on the keyboard: it presses "no key", or waits longer than 65 seconds, or holds a character that cannot be typed.`);
    out.push(...one, 0);
  }
  return Uint8Array.from(out);
}

export function deserializeMacros(bytes, count, qmk) {
  const parts = []; let cur = [];
  for (const b of bytes) { if (b === 0) { parts.push(cur); cur = []; } else cur.push(b); }
  parts.push(cur);
  while (parts.length < count) parts.push([]);
  return parts.slice(0, count).map((data) => {
    const seq = [];
    let i = 0;
    while (i < data.length) {
      if (data[i] === 1) {
        const act = data[i + 1];
        if (act >= 1 && act <= 3) {
          if (i + 2 >= data.length) break;
          addKey(seq, act, data[i + 2]); i += 3;
        } else if (act >= 5 && act <= 7) {
          if (i + 3 >= data.length) break;
          let kc = data[i + 2] | (data[i + 3] << 8);
          if (kc > 0xFF00) kc = (kc & 0xFF) << 8;
          addKey(seq, act - 4, kc); i += 4;
        } else if (act === 4) {
          if (i + 3 >= data.length) break;
          seq.push(['delay', (data[i + 2] - 1) + (data[i + 3] - 1) * 255]); i += 4;
        } else i += 2;
      } else {
        const ch = String.fromCharCode(data[i]);
        const last = seq[seq.length - 1];
        if (last && last[0] === 'text') last[1] += ch; else seq.push(['text', ch]);
        i++;
      }
    }
    return seq;
  });
  function addKey(seq, act, kc) {
    const tag = ['', 'tap', 'down', 'up'][act];
    const last = seq[seq.length - 1];
    const name = qmk.serialize(kc);
    if (last && last[0] === tag) last.push(name); else seq.push([tag, name]);
  }
}
