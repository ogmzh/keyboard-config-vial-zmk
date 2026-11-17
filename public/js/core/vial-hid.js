// Talks to a Vial keyboard over USB (raw HID, 32-byte packets): reads its full state, makes a backup in
// Vial's own .vil format, and writes a translated keymap. The byte layouts follow vial-gui and vial-qmk.

import { QK } from './qmk.js';
import { buildVil, serializeMacros, deserializeMacros } from './vil.js';

const MSG = 32;
const CHUNK = 28;
const VIAL = 0xFE;
// width in bytes of each QMK setting value
export const QSID_WIDTH = { 1: 1, 2: 2, 3: 1, 4: 2, 5: 1, 6: 2, 7: 2, 8: 1, 9: 2, 10: 2, 11: 2, 12: 2, 13: 2, 14: 2, 15: 2, 16: 2, 17: 2, 18: 2, 19: 2, 20: 1, 21: 4, 22: 1, 23: 1, 24: 1, 25: 2, 26: 1, 27: 2 };

// How long to wait for one answer. Saving to the keyboard's memory can hold an answer up for a moment.
const ANSWER_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCKED = 'The keyboard is locked, and a locked keyboard ignores macros. Nothing was written. Try again, and hold the two keys until the bar is full.';

// Both halves of a split Vial keyboard look exactly the same over USB, so the app keeps a mark on the half
// itself: one keycode in a matrix position of the last layer that has no switch and so can never be pressed.
// Vial does not show such positions and never rewrites them; neither does a keymap written from this app.
export const SIDE_CODES = { left: 0x000F /* KC_L */, right: 0x0015 /* KC_R */ };
export function sideCell(target) {
  const c = target.sideCell;
  if (!c || c.layer >= target.layers || c.row >= target.matrix.rows || c.col >= target.matrix.cols) return null;
  if (target.matrixKeys.some((k) => k.row === c.row && k.col === c.col)) return null; // never a real key
  return c;
}
const sideFromCode = (code) => (code === SIDE_CODES.left ? 'left' : code === SIDE_CODES.right ? 'right' : null);
// The mark, taken from a state that readState() returned.
export function sideOf(state, target) {
  const c = sideCell(target);
  return c && state.keymap[c.layer] ? sideFromCode(state.keymap[c.layer][c.row][c.col]) : null;
}

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const le16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];

export class WebHidTransport {
  constructor(device) {
    this.device = device;
    this.waiter = null;
    // The keyboard answers every packet exactly once, in order. When the app stops waiting for an answer,
    // that answer is still on its way; it is counted here and thrown away when it arrives, so that it is
    // never mistaken for the answer to the next request. The count is never forgiven: if an answer really
    // was lost, the requests after it fail with "did not answer" and the app stops, which is the safe way out.
    this.owed = 0;
    this.turn = Promise.resolve();
    this.onReport = (e) => {
      if (this.owed) { this.owed--; return; }
      const w = this.waiter; if (!w) return;
      this.waiter = null;
      w(new Uint8Array(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength)));
    };
    device.addEventListener('inputreport', this.onReport);
  }

  static supported() { return typeof navigator !== 'undefined' && !!navigator.hid; }
  static isRawHid(device) { return device.collections.some((c) => c.usagePage === 0xFF60 && c.usage === 0x61); }

  // Keyboards this page was already allowed to use and that are plugged in now. No prompt.
  static async granted() {
    if (!WebHidTransport.supported()) return [];
    return (await navigator.hid.getDevices()).filter((d) => WebHidTransport.isRawHid(d));
  }

  static async open(device) {
    if (!device.opened) await device.open();
    return new WebHidTransport(device);
  }

  static async request() {
    if (!WebHidTransport.supported()) throw new Error('This browser cannot talk to USB keyboards (WebHID is missing). Use Chrome, Edge or Brave, or export a .vil file instead.');
    const devices = await navigator.hid.requestDevice({ filters: [{ usagePage: 0xFF60, usage: 0x61 }] });
    const device = devices.find((d) => WebHidTransport.isRawHid(d)) || devices[0];
    if (!device) throw new Error('No keyboard was chosen.');
    return WebHidTransport.open(device);
  }

  // One request at a time. A second caller waits its turn, so two parts of the page (or two clicks on the same
  // button) can never take each other's answers.
  send(msg, timeoutMs = ANSWER_MS) {
    const run = () => this.sendNow(msg, timeoutMs);
    const mine = this.turn.then(run, run);
    this.turn = mine.catch(() => {});
    return mine;
  }

  sendNow(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; this.owed++; reject(new Error('The keyboard did not answer.')); }, timeoutMs);
      this.waiter = (data) => { clearTimeout(timer); resolve(data); };
      this.device.sendReport(0, msg).catch((e) => { clearTimeout(timer); this.waiter = null; reject(e); });
    });
  }

  get name() { return this.device.productName || 'keyboard'; }
  get vendorId() { return this.device.vendorId; }
  get productId() { return this.device.productId; }
  async close() { this.device.removeEventListener('inputreport', this.onReport); try { await this.device.close(); } catch { /* already closed */ } }
}

export class VialKeyboard {
  constructor(transport, qmk) { this.t = transport; this.qmk = qmk; }

  async cmd(bytes, tries = 4) {
    const msg = new Uint8Array(MSG);
    msg.set(bytes);
    let last;
    for (let i = 0; i < tries; i++) {
      let d;
      try { d = await this.t.send(msg); } catch (e) { last = e; await sleep(150); continue; }
      // Every command except the Vial ones (0xFE) comes back with its own first bytes still in place. If they
      // differ, this answer belongs to some other request: another program is talking to the keyboard, or the
      // answers have slipped out of step. Nothing read that way can be trusted, so stop.
      if (d.length !== MSG) throw new Error('The keyboard sent an answer of the wrong size. Unplug it, plug it back in and try again.');
      const echo = msg[0] === VIAL ? 0 : [0x04, 0x05, 0x0E, 0x0F, 0x12].includes(msg[0]) ? 4 : 1;
      for (let k = 0; k < echo; k++) {
        if (d[k] !== msg[k]) throw new Error('The keyboard sent an answer that belongs to a different request. Close Vial or vial.rocks if it is open, unplug the keyboard, plug it back in and try again.');
      }
      return d;
    }
    throw last;
  }

  // Refuses anything that is not the keyboard this app knows. Sends nothing that changes the keyboard.
  async check(target) {
    if (target.usb && this.t.productId !== undefined && this.t.productId === target.usb.miniProductId) {
      throw new Error(`This is the ${target.name} Mini (5 columns). It has the same Vial id as the 6-column board, but this app only knows the 6-column layout. Nothing was changed.`);
    }
    if (target.usb && this.t.vendorId !== undefined && this.t.vendorId !== target.usb.vendorId) {
      throw new Error(`The device you picked is not a ${target.name}. Nothing was changed.`);
    }
    const id = await this.identify();
    if (id.uid !== target.uid) throw new Error(`This is not a ${target.name} (keyboard id ${id.uid}). Nothing was changed.`);
    if (id.vialProtocol !== 6) throw new Error(`This keyboard speaks Vial protocol ${id.vialProtocol}; this app supports 6. Use the .vil export and load it in Vial.`);
    // While an unlock is under way the firmware ignores almost every command and just sends it back.
    if ((await this.unlockStatus()).inProgress) throw new Error('The keyboard is still waiting for an unlock that was started and not finished, and ignores everything else until then. Unplug it, plug it back in and try again. Nothing was changed.');
    // Asked last: while an unlock is under way the VIA version comes back as 0, and the message above is the true one.
    if (id.viaProtocol < (target.viaProtocol || 9)) throw new Error(`This keyboard speaks VIA protocol ${id.viaProtocol}; this app needs ${target.viaProtocol || 9} or newer. Nothing was changed.`);
    return id;
  }

  // Which half this is, by the mark this app left on it: 'left', 'right', or null when there is no mark.
  async readSide(target) {
    const c = sideCell(target);
    if (!c) return null;
    await this.check(target);
    return sideFromCode(u16be(await this.cmd([0x04, c.layer, c.row, c.col]), 4));
  }

  // Marks the plugged-in half as left or right (or removes the mark with side = null) and reads it back.
  async writeSide(target, side) {
    const c = sideCell(target);
    if (!c) throw new Error('This keyboard has no spare place for the mark.');
    if (side !== null && !(side in SIDE_CODES)) throw new Error('The side must be left or right.');
    await this.check(target);
    const code = side === null ? QK.TRNS : SIDE_CODES[side];
    await this.cmd([0x05, c.layer, c.row, c.col, code >> 8, code & 0xFF]);
    const stored = sideFromCode(u16be(await this.cmd([0x04, c.layer, c.row, c.col]), 4));
    if (stored !== side) throw new Error('The keyboard did not keep the mark.');
    return stored;
  }

  async identify() {
    const via = await this.cmd([0x01]);
    const id = await this.cmd([VIAL, 0x00]);
    let uid = 0n;
    for (let i = 0; i < 8; i++) uid |= BigInt(id[4 + i]) << BigInt(8 * i);
    return {
      viaProtocol: u16be(via, 1),
      vialProtocol: (id[0] | (id[1] << 8) | (id[2] << 16) | (id[3] << 24)) >>> 0,
      uid: uid.toString(),
    };
  }

  async unlockStatus() {
    const d = await this.cmd([VIAL, 0x05]);
    const keys = [];
    for (let x = 0; x < 15; x++) { const r = d[2 + x * 2]; const c = d[3 + x * 2]; if (r !== 255 && c !== 255) keys.push([r, c]); }
    return { unlocked: d[0] === 1, inProgress: d[1] === 1, keys };
  }

  // Reads everything Vial itself saves in a layout file.
  async readState(target, onProgress = () => {}) {
    const id = await this.check(target);
    const { rows, cols } = target.matrix;
    const s = { ...id, rows, cols };
    s.layers = (await this.cmd([0x11]))[1];
    if (s.layers < 1 || s.layers > 32) throw new Error(`The keyboard says it has ${s.layers} layers, which cannot be right. Nothing was changed.`);
    s.macroCount = (await this.cmd([0x0C]))[1];
    s.macroSize = u16be(await this.cmd([0x0D]), 1);
    const dyn = await this.cmd([VIAL, 0x0D, 0x00]);
    s.counts = { tapDance: dyn[0], combos: dyn[1], keyOverrides: dyn[2], altRepeat: dyn[3] };
    s.features = { capsWord: !!(dyn[31] & 1), layerLock: !!(dyn[31] & 2) };

    onProgress('Reading keys');
    const size = s.layers * rows * cols * 2;
    const buf = new Uint8Array(size);
    for (let off = 0; off < size; off += CHUNK) {
      const sz = Math.min(CHUNK, size - off);
      const d = await this.cmd([0x12, off >> 8, off & 0xFF, sz]);
      buf.set(d.slice(4, 4 + sz), off);
    }
    s.keymap = [];
    for (let l = 0; l < s.layers; l++) {
      const layer = [];
      for (let r = 0; r < rows; r++) {
        const row = [];
        for (let c = 0; c < cols; c++) row.push(u16be(buf, (l * rows * cols + r * cols + c) * 2));
        layer.push(row);
      }
      s.keymap.push(layer);
    }

    onProgress('Reading encoders');
    s.encoders = [];
    for (let l = 0; l < s.layers; l++) {
      const layer = [];
      for (let e = 0; e < (target.encoders || 0); e++) {
        const d = await this.cmd([VIAL, 0x03, l, e]);
        layer.push([u16be(d, 0), u16be(d, 2)]);
      }
      s.encoders.push(layer);
    }
    const lo = await this.cmd([0x02, 0x02]);
    s.layoutOptions = ((lo[2] << 24) | (lo[3] << 16) | (lo[4] << 8) | lo[5]) >>> 0;

    onProgress('Reading macros');
    const mac = [];
    let nul = 0;
    for (let off = 0; off < s.macroSize && nul <= s.macroCount; off += CHUNK) {
      const sz = Math.min(CHUNK, s.macroSize - off);
      const d = await this.cmd([0x0E, off >> 8, off & 0xFF, sz]);
      for (const b of d.slice(4, 4 + sz)) { mac.push(b); if (b === 0) nul++; }
    }
    // keep exactly macroCount NUL-terminated macros
    const parts = []; let cur = [];
    for (const b of mac) { if (b === 0) { parts.push(cur); cur = []; } else cur.push(b); }
    while (parts.length < s.macroCount) parts.push([]);
    s.macroBytes = Uint8Array.from(parts.slice(0, s.macroCount).flatMap((p) => [...p, 0]));
    // The firmware runs no macro while the last byte of the macro memory is not zero (see apply()).
    const lastByte = s.macroSize - 1;
    s.macrosOff = s.macroSize > 0 && (await this.cmd([0x0E, lastByte >> 8, lastByte & 0xFF, 1]))[4] !== 0;

    onProgress('Reading tap dances, combos and overrides');
    const entries = async (cmd, count, parse) => {
      const out = [];
      for (let i = 0; i < count; i++) {
        const d = await this.cmd([VIAL, 0x0D, cmd, i]);
        if (d[0] !== 0) throw new Error('The keyboard refused to return a stored entry.');
        out.push(parse(d.slice(1)));
      }
      return out;
    };
    s.tapDance = await entries(0x01, s.counts.tapDance, (b) => [u16le(b, 0), u16le(b, 2), u16le(b, 4), u16le(b, 6), u16le(b, 8)]);
    s.combos = await entries(0x03, s.counts.combos, (b) => [u16le(b, 0), u16le(b, 2), u16le(b, 4), u16le(b, 6), u16le(b, 8)]);
    s.keyOverrides = await entries(0x05, s.counts.keyOverrides, (b) => ({ trigger: u16le(b, 0), replacement: u16le(b, 2), layers: u16le(b, 4), trigger_mods: b[6], negative_mod_mask: b[7], suppressed_mods: b[8], options: b[9] }));
    s.altRepeat = await entries(0x07, s.counts.altRepeat, (b) => ({ keycode: u16le(b, 0), alt_keycode: u16le(b, 2), allowed_mods: b[4], options: b[5] }));

    onProgress('Reading settings');
    s.settings = {};
    const supported = new Set();
    let curQ = 0;
    for (let guard = 0; guard < 64 && curQ !== 0xFFFF; guard++) {
      const d = await this.cmd([VIAL, 0x09, ...le16(curQ)]);
      for (let x = 0; x + 1 < d.length; x += 2) {
        const q = u16le(d, x);
        curQ = Math.max(curQ, q);
        if (q !== 0xFFFF) supported.add(q);
      }
    }
    for (const q of [...supported].sort((a, b) => a - b)) {
      const w = QSID_WIDTH[q];
      if (!w) continue;
      const d = await this.cmd([VIAL, 0x0A, ...le16(q)]);
      if (d[0] !== 0) continue;
      let v = 0; for (let i = 0; i < w; i++) v += d[1 + i] * 2 ** (8 * i);
      s.settings[q] = v;
    }
    s.unlocked = (await this.unlockStatus()).unlocked;
    return s;
  }

  // The state as a .vil object, loadable by Vial itself ("File > Load saved layout").
  stateToVil(s, target) {
    const q = this.qmk;
    const exists = new Set(target.matrixKeys.map((k) => `${k.row},${k.col}`));
    return {
      version: 1,
      uid: '__UID__',
      layout: s.keymap.map((layer) => layer.map((row, r) => row.map((code, c) => (exists.has(`${r},${c}`) ? q.serialize(code) : -1)))),
      encoder_layout: s.encoders.map((layer) => layer.map((pair) => pair.map((c) => q.serialize(c)))),
      layout_options: s.layoutOptions,
      macro: deserializeMacros(s.macroBytes, s.macroCount, q),
      vial_protocol: s.vialProtocol,
      via_protocol: s.viaProtocol,
      tap_dance: s.tapDance.map((e) => [...e.slice(0, 4).map((c) => q.serialize(c)), e[4]]),
      combo: s.combos.map((e) => e.map((c) => q.serialize(c))),
      key_override: s.keyOverrides.map((e) => ({ ...e, trigger: q.serialize(e.trigger), replacement: q.serialize(e.replacement) })),
      alt_repeat_key: s.altRepeat.map((e) => ({ ...e, keycode: q.serialize(e.keycode), alt_keycode: q.serialize(e.alt_keycode) })),
      settings: Object.fromEntries(Object.entries(s.settings).map(([k, v]) => [String(k), v])),
    };
  }

  // Works out what has to be written. Nothing is sent here.
  plan(tr, s, target, { clearUnused = true } = {}) {
    const q = this.qmk;
    const ops = [];
    const vil = buildVil(tr, { capacity: { macros: s.macroCount, tapDance: s.counts.tapDance, combos: s.counts.combos, keyOverrides: s.counts.keyOverrides } });
    const notes = [];
    vil.layout.forEach((layer, l) => {
      if (l >= s.layers) return;
      layer.forEach((row, r) => row.forEach((name, c) => {
        if (name === -1) return;
        const code = q.decode(name);
        if (s.keymap[l][r][c] !== code) ops.push({ type: 'key', layer: l, row: r, col: c, code, was: s.keymap[l][r][c] });
      }));
    });
    vil.encoder_layout.forEach((layer, l) => {
      if (l >= s.layers) return;
      layer.forEach((pair, e) => pair.forEach((name, dir) => {
        const code = q.decode(name);
        if (s.encoders[l] && s.encoders[l][e] && s.encoders[l][e][dir] !== code) ops.push({ type: 'encoder', layer: l, index: e, dir, code, was: s.encoders[l][e][dir] });
      }));
    });
    if (tr.layoutOptions !== undefined && tr.layoutOptions !== null && tr.layoutOptions !== s.layoutOptions) ops.push({ type: 'layoutOptions', value: tr.layoutOptions, was: s.layoutOptions });
    const used = { tapDance: tr.tapDance.length, combos: tr.combos.length, keyOverrides: tr.keyOverrides.length };
    for (const [kind, list, have] of [['tapDance', vil.tap_dance, s.tapDance], ['combo', vil.combo, s.combos]]) {
      const usedCount = kind === 'tapDance' ? used.tapDance : used.combos;
      list.forEach((entry, i) => {
        if (i >= have.length || (!clearUnused && i >= usedCount)) return;
        const nums = entry.map((v, k) => (kind === 'tapDance' && k === 4 ? v : q.decode(v)));
        if (nums.some((v, k) => v !== have[i][k])) ops.push({ type: kind, index: i, entry: nums });
      });
      if (usedCount > have.length) notes.push(`The keyboard stores ${have.length} ${kind === 'tapDance' ? 'tap dances' : 'combos'}; ${usedCount - have.length} did not fit.`);
    }
    vil.key_override.forEach((e, i) => {
      if (i >= s.keyOverrides.length || (!clearUnused && i >= used.keyOverrides)) return;
      const n = { ...e, trigger: q.decode(e.trigger), replacement: q.decode(e.replacement) };
      const h = s.keyOverrides[i];
      if (Object.keys(n).some((k) => n[k] !== h[k])) ops.push({ type: 'keyOverride', index: i, entry: n });
    });
    if (used.keyOverrides > s.keyOverrides.length) notes.push(`The keyboard stores ${s.keyOverrides.length} key overrides; ${used.keyOverrides - s.keyOverrides.length} did not fit.`);
    if (tr.macros.length > s.macroCount) notes.push(`The keyboard stores ${s.macroCount} macros; ${tr.macros.length - s.macroCount} did not fit.`);
    const macroBytes = serializeMacros(vil.macro, s.macroCount, q);
    if (macroBytes.length > s.macroSize) notes.push(`The macros need ${macroBytes.length} bytes but the keyboard has ${s.macroSize}. Macros are left as they are.`);
    else if (!sameBytes(macroBytes, s.macroBytes) || s.macrosOff) ops.push({ type: 'macros', bytes: macroBytes, size: s.macroSize });
    if (s.macrosOff) notes.push('The macros on the keyboard are switched off, because an earlier write of them was cut short. This write switches them on again.');
    for (const [qsid, value] of Object.entries(tr.settings)) {
      const id = Number(qsid);
      if (!(id in s.settings)) { notes.push(`Setting ${id} is not supported by this firmware and is skipped.`); continue; }
      if (s.settings[id] !== value) ops.push({ type: 'setting', qsid: id, value, was: s.settings[id] });
    }
    const needsUnlock = ops.some((o) => o.type === 'macros' || o.code === QK.BOOT || (o.entry && (Array.isArray(o.entry) ? o.entry.includes(QK.BOOT) : o.entry.replacement === QK.BOOT)));
    const count = (t) => ops.filter((o) => o.type === t).length;
    return {
      ops, notes, needsUnlock,
      summary: { keys: count('key'), encoders: count('encoder'), tapDances: count('tapDance'), combos: count('combo'), keyOverrides: count('keyOverride'), macros: count('macros'), settings: count('setting'), layoutOptions: count('layoutOptions') },
    };
  }

  // Asks the keyboard to unlock; the person must hold the unlock keys until done. Returns false if cancelled.
  // The firmware has no way to call an unlock off: after a cancel it keeps waiting for the keys, and ignores
  // other commands, until they are held or the keyboard is unplugged.
  async unlock({ onProgress = () => {}, shouldCancel = () => false, pollMs = 200 } = {}) {
    const st = await this.unlockStatus();
    if (st.unlocked) return true;
    await this.cmd([VIAL, 0x06]);
    let max = 1;
    for (;;) {
      if (shouldCancel()) return false;
      const d = await this.cmd([VIAL, 0x07]);
      if (d[0] === 1) { onProgress(1, st.keys); return true; }
      max = Math.max(max, d[2]);
      onProgress((max - d[2]) / max, st.keys);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async lock() { await this.cmd([VIAL, 0x08]); }

  async apply(plan, onProgress = () => {}) {
    let done = 0;
    // Macros go first. While the keyboard is locked the firmware ignores a macro write and answers as if all
    // were well, so that is checked here, before any key has been pointed at a macro that is not there.
    const ops = [...plan.ops].sort((a, b) => (b.type === 'macros') - (a.type === 'macros'));
    for (const op of ops) {
      switch (op.type) {
        case 'key': await this.cmd([0x05, op.layer, op.row, op.col, op.code >> 8, op.code & 0xFF]); break;
        case 'encoder': await this.cmd([VIAL, 0x04, op.layer, op.index, op.dir, op.code >> 8, op.code & 0xFF]); break;
        case 'layoutOptions': await this.cmd([0x03, 0x02, (op.value >>> 24) & 0xFF, (op.value >>> 16) & 0xFF, (op.value >>> 8) & 0xFF, op.value & 0xFF]); break;
        case 'tapDance': await this.cmd([VIAL, 0x0D, 0x02, op.index, ...op.entry.flatMap(le16)]); break;
        case 'combo': await this.cmd([VIAL, 0x0D, 0x04, op.index, ...op.entry.flatMap(le16)]); break;
        case 'keyOverride': {
          const e = op.entry;
          await this.cmd([VIAL, 0x0D, 0x06, op.index, ...le16(e.trigger), ...le16(e.replacement), ...le16(e.layers), e.trigger_mods, e.negative_mod_mask, e.suppressed_mods, e.options]);
          break;
        }
        case 'macros': {
          // The firmware runs no macro while the last byte of the macro memory is not zero. That is its own
          // guard against half-written macros, and VIA uses it the same way: switch the macros off, write
          // them, switch them on. A write that is cut short leaves them off, never half-written and live.
          const last = op.size ? op.size - 1 : -1;
          const guard = async (v) => { if (last >= 0) await this.cmd([0x0F, last >> 8, last & 0xFF, 1, v]); };
          if (!(await this.unlockStatus()).unlocked) throw new Error(LOCKED);
          await guard(0xFF);
          // the proof that the keyboard takes macro writes right now: the byte just written reads back
          if (last >= 0 && (await this.cmd([0x0E, last >> 8, last & 0xFF, 1]))[4] !== 0xFF) throw new Error(LOCKED);
          try {
            for (let off = 0; off < op.bytes.length; off += CHUNK) {
              const chunk = op.bytes.slice(off, off + CHUNK);
              await this.cmd([0x0F, off >> 8, off & 0xFF, chunk.length, ...chunk]);
            }
          } catch (e) {
            e.message += ' The macros on the keyboard are switched off until a write of them finishes; the keys are not affected.';
            throw e;
          }
          await guard(0x00);
          break;
        }
        case 'setting': {
          const w = QSID_WIDTH[op.qsid] || 1;
          const bytes = []; for (let i = 0; i < w; i++) bytes.push(Math.floor(op.value / 2 ** (8 * i)) & 0xFF);
          await this.cmd([VIAL, 0x0B, ...le16(op.qsid), ...bytes]);
          break;
        }
        default: throw new Error('Unknown operation ' + op.type);
      }
      onProgress(++done / ops.length);
    }
  }
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
