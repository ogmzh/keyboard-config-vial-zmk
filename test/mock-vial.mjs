// A pretend Vial keyboard for tests: stores what it is told, with the firmware's lock rules.
// Packet layouts follow vial-qmk (quantum/via.c, quantum/vial.c).
export const MOCK_SETTINGS = { 1: 1, 2: 2, 3: 1, 4: 2, 5: 1, 6: 2, 7: 2, 9: 2, 10: 2, 11: 2, 12: 2, 13: 2, 14: 2, 15: 2, 16: 2, 17: 2, 18: 2, 19: 2, 20: 1, 21: 4, 22: 1, 23: 1, 24: 1, 25: 2, 26: 1, 27: 2 };

export class MockVial {
  constructor(o = {}) {
    Object.assign(this, { uidBytes: [0x89, 0x36, 0x2A, 0xC7, 0xFA, 0xD8, 0x89, 0x45], rows: 8, cols: 7, layers: 16, encoderCount: 4, macroCount: 16, macroSize: 1024, nTd: 32, nCombo: 32, nKo: 32, nArep: 32, unlockKeys: [[0, 0], [0, 1]] }, o);
    this.keymap = new Uint8Array(this.layers * this.rows * this.cols * 2);
    this.encoders = new Uint8Array(this.layers * this.encoderCount * 4);
    this.layoutOptions = 0;
    this.macro = new Uint8Array(this.macroSize);
    const fill = (n, bytes) => Array.from({ length: n }, () => Uint8Array.from(bytes));
    this.td = fill(this.nTd, [0, 0, 0, 0, 0, 0, 0, 0, 200, 0]);
    this.combo = fill(this.nCombo, new Array(10).fill(0));
    this.ko = fill(this.nKo, [0, 0, 0, 0, 0xFF, 0xFF, 0, 0, 0, 7]);
    this.arep = fill(this.nArep, new Array(6).fill(0));
    this.settings = new Map(Object.entries(MOCK_SETTINGS).map(([q, w]) => [Number(q), new Uint8Array(w)]));
    this.settings.get(7).set([200, 0]); this.settings.get(2).set([50, 0]); this.settings.get(6).set([0x88, 0x13]);
    this.unlocked = 0; this.inProgress = 0; this.counter = 50; this.holding = false;
    this.log = [];
  }

  async send(msgIn) {
    if (msgIn.length !== 32) throw new Error('packets must be 32 bytes');
    const m = Uint8Array.from(msgIn);
    this.log.push(Uint8Array.from(m));
    const d = m.subarray(1);
    // vial-qmk, raw_hid_receive: during an unlock everything but these Vial commands is sent back untouched
    if (this.inProgress && !(m[0] === 0xFE && [0x00, 0x01, 0x02, 0x05, 0x06, 0x07].includes(m[1]))) return m;
    switch (m[0]) {
      case 0x01: d[0] = 0; d[1] = 9; break;
      case 0x02: if (d[0] === 0x02) { const v = this.layoutOptions; d[1] = v >>> 24; d[2] = (v >>> 16) & 255; d[3] = (v >>> 8) & 255; d[4] = v & 255; } break;
      case 0x03: if (d[0] === 0x02) this.layoutOptions = ((d[1] << 24) | (d[2] << 16) | (d[3] << 8) | d[4]) >>> 0; break;
      case 0x04: { const o = this.kOff(d[0], d[1], d[2]); if (o >= 0) { d[3] = this.keymap[o]; d[4] = this.keymap[o + 1]; } break; }
      case 0x05: { const o = this.kOff(d[0], d[1], d[2]); if (o >= 0) { this.keymap[o] = d[3]; this.keymap[o + 1] = d[4]; } break; }
      case 0x0C: d[0] = this.macroCount; break;
      case 0x0D: d[0] = this.macroSize >> 8; d[1] = this.macroSize & 255; break;
      case 0x0E: { const off = (d[0] << 8) | d[1]; const sz = d[2]; if (sz <= 28) for (let i = 0; i < sz; i++) d[3 + i] = off + i < this.macroSize ? this.macro[off + i] : 0; break; }
      case 0x0F: { if (!this.unlocked) break; const off = (d[0] << 8) | d[1]; const sz = d[2]; if (sz <= 28) for (let i = 0; i < sz; i++) if (off + i < this.macroSize) this.macro[off + i] = d[3 + i]; break; }
      case 0x11: d[0] = this.layers; break;
      case 0x12: { const off = (d[0] << 8) | d[1]; const sz = d[2]; if (sz <= 28) for (let i = 0; i < sz; i++) d[3 + i] = off + i < this.keymap.length ? this.keymap[off + i] : 0; break; }
      case 0xFE: this.vial(m); break;
      default: m[0] = 0xFF;
    }
    return m;
  }

  kOff(l, r, c) { return l < this.layers && r < this.rows && c < this.cols ? (l * this.rows * this.cols + r * this.cols + c) * 2 : -1; }
  firewall(hi, lo) { return (hi << 8 | lo) === 0x7C00 && !this.unlocked ? [0, 0] : [hi, lo]; }

  vial(m) {
    switch (m[1]) {
      case 0x00: m.fill(0); m[0] = 6; m.set(this.uidBytes, 4); m[12] = 1; break;
      case 0x03: { const o = (m[2] * this.encoderCount + m[3]) * 4; m.set(this.encoders.subarray(o, o + 4), 0); break; }
      case 0x04: { const o = (m[2] * this.encoderCount + m[3]) * 4 + m[4] * 2; const [hi, lo] = this.firewall(m[5], m[6]); if (m[2] < this.layers && m[3] < this.encoderCount) { this.encoders[o] = hi; this.encoders[o + 1] = lo; } break; }
      case 0x05: m.fill(0xFF); m[0] = this.unlocked; m[1] = this.inProgress; this.unlockKeys.forEach(([r, c], i) => { m[2 + i * 2] = r; m[3 + i * 2] = c; }); break;
      case 0x06: this.inProgress = 1; this.counter = 50; break;
      case 0x07:
        if (this.inProgress) { if (this.holding) { this.counter -= 10; if (this.counter <= 0) { this.counter = 0; this.inProgress = 0; this.unlocked = 1; } } else this.counter = 50; }
        m[0] = this.unlocked; m[1] = this.inProgress; m[2] = this.counter; break;
      case 0x08: this.unlocked = 0; break;
      case 0x09: { const gt = m[2] | (m[3] << 8); m.fill(0xFF); let o = 0; for (const q of [...this.settings.keys()].sort((a, b) => a - b)) if (q > gt && o + 2 <= 32) { m[o] = q & 255; m[o + 1] = q >> 8; o += 2; } break; }
      case 0x0A: { const q = m[2] | (m[3] << 8); const v = this.settings.get(q); if (!v) { m[0] = 0xFF; break; } m[0] = 0; m.set(v, 1); break; }
      case 0x0B: { const q = m[2] | (m[3] << 8); const v = this.settings.get(q); if (!v) { m[0] = 0xFF; break; } v.set(m.subarray(4, 4 + v.length)); m[0] = 0; break; }
      case 0x0D: this.dynamic(m); break;
      default: break;
    }
  }

  dynamic(m) {
    const idx = m[3];
    const get = (list) => { if (idx >= list.length) { m[0] = 0xFF; return; } m[0] = 0; m.set(list[idx], 1); };
    const set = (list, fw) => { if (idx >= list.length) { m[0] = 0xFF; return; } const e = Uint8Array.from(m.subarray(4, 4 + list[idx].length)); for (const o of fw) { const [lo, hi] = [e[o], e[o + 1]]; const [h2, l2] = this.firewall(hi, lo); e[o] = l2; e[o + 1] = h2; } list[idx] = e; m[0] = 0; };
    switch (m[2]) {
      case 0x00: m.fill(0); m[0] = this.nTd; m[1] = this.nCombo; m[2] = this.nKo; m[3] = this.nArep; m[31] = 1; break;
      case 0x01: get(this.td); break;
      case 0x02: set(this.td, [0, 2, 4, 6]); break;
      case 0x03: get(this.combo); break;
      case 0x04: set(this.combo, [8]); break;
      case 0x05: get(this.ko); break;
      case 0x06: set(this.ko, [2]); break;
      case 0x07: get(this.arep); break;
      case 0x08: set(this.arep, []); break;
      default: break;
    }
  }

  dump() {
    const hex = (u) => Buffer.from(u).toString('hex');
    return {
      keymap: hex(this.keymap), encoders: hex(this.encoders), layoutOptions: this.layoutOptions, macro: hex(this.macro),
      td: this.td.map(hex), combo: this.combo.map(hex), ko: this.ko.map(hex), arep: this.arep.map(hex),
      settings: Object.fromEntries([...this.settings.entries()].map(([q, v]) => [q, hex(v)])),
    };
  }
}
