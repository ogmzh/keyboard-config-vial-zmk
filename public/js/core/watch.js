// Keeps the picture of what is plugged in up to date, in the browser:
// asks the server every two seconds while the page is showing, and reads the side mark from the Vial keyboard.
//
// The page talks to the Vial keyboard only when it is in front (visible and focused) or when you click
// something, and closes the keyboard again straight away. Another program that has the keyboard open at
// the same moment (Vial, vial.rocks) would otherwise receive this page's answers mixed into its own.

import { VialKeyboard, WebHidTransport } from './vial-hid.js';
import { isVialDevice } from './connection.js';

const shape = (d) => ({ vendorId: d.vendorId, productId: d.productId, product: d.productName || '' });

export class ConnectionWatch {
  // target: () => the Vial keyboard definition; onChange: called when anything changed
  constructor({ target, onChange = () => {}, pollMs = 2000 }) {
    this.target = target; this.onChange = onChange; this.pollMs = pollMs;
    this.conn = { server: 'unknown', usb: { supported: false, devices: [] }, volumes: [], halves: {}, hid: { supported: WebHidTransport.supported(), devices: [] } };
    this.sides = new Map(); // HIDDevice -> { checked, side, error }
    this.chain = Promise.resolve();
    this.paused = 0; this.wantProbe = false; this.polling = false;
  }

  start() {
    // the server's list first: it says whether the keyboard has a serial number, and then there is no mark to read
    this.pollServer().then(() => this.scan({ probe: true }));
    setInterval(() => this.pollServer(), this.pollMs);
    document.addEventListener('visibilitychange', () => this.wake());
    window.addEventListener('focus', () => this.wake());
    if (WebHidTransport.supported()) {
      navigator.hid.addEventListener('connect', () => this.pollServer().then(() => this.scan({ probe: true })));
      navigator.hid.addEventListener('disconnect', () => this.scan());
    }
  }

  set(patch) {
    const before = JSON.stringify(this.conn);
    Object.assign(this.conn, patch);
    if (JSON.stringify(this.conn) !== before) this.onChange();
  }

  inFront() { return document.visibilityState === 'visible' && document.hasFocus(); }
  wake() { this.pollServer(); if (this.wantProbe) this.scan({ probe: true }); }

  async pollServer() {
    if (this.polling || document.visibilityState !== 'visible') return;
    this.polling = true;
    const none = { supported: false, devices: [] };
    let next;
    try {
      const res = await fetch('/api/connection');
      if (res.status === 404) {
        // a server started before this feature existed: it still knows the bootloader drives
        const old = await fetch('/api/volumes').then((r) => (r.ok ? r.json() : {}));
        next = { server: 'old', usb: none, volumes: old.volumes || [] };
      } else if (!res.ok) throw new Error('bad answer');
      else { const r = await res.json(); next = { server: 'ok', usb: r.usb || none, volumes: r.volumes || [], halves: r.halves || {} }; }
    } catch { next = { server: 'down', usb: none, volumes: [] }; }
    this.polling = false;
    this.set(next);
  }

  async devices() {
    const t = this.target();
    return (await WebHidTransport.granted()).filter((d) => isVialDevice(shape(d), t));
  }

  // Looks at which keyboards the browser may use. With probe, also reads the side mark of each new one.
  scan(opts = {}) {
    this.chain = this.chain.then(() => this.scanNow(opts)).catch(() => {});
    return this.chain;
  }

  async scanNow({ probe = false, now = false }) {
    if (!WebHidTransport.supported()) return;
    const list = await this.devices();
    for (const d of [...this.sides.keys()]) if (!list.includes(d)) this.sides.delete(d);
    if (probe && !this.hasSerial()) {
      if (this.paused || !(now || this.inFront())) this.wantProbe = true; // later, when the page is in front again
      else {
        this.wantProbe = false;
        for (const d of list) if (!this.sides.has(d)) this.sides.set(d, await this.probe(d));
      }
    }
    this.publish(list);
  }

  publish(list) {
    this.set({ hid: { supported: true, devices: list.map((d) => ({ ...shape(d), checked: false, side: null, error: null, ...(this.sides.get(d) || {}) })) } });
  }

  async probe(device) {
    const out = { checked: true, side: null, error: null };
    let t = null;
    try { t = await WebHidTransport.open(device); out.side = await new VialKeyboard(t, null).readSide(this.target()); }
    catch (e) { out.error = e.message || String(e); }
    finally { if (t) await t.close(); }
    return out;
  }

  // A keyboard that gives a serial number is known by that; the page does not need to talk to it to tell the half.
  hasSerial() {
    const t = this.target();
    return this.conn.usb.devices.some((d) => d.serial && isVialDevice(d, t));
  }

  // From a click: remembers which half has this serial number (null forgets it).
  // The server keeps it in its settings file; nothing is sent to the keyboard.
  async name(serial, side) {
    const res = await fetch('/api/half', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Keymap-Bridge': '1' }, body: JSON.stringify({ serial, side }) });
    if (res.status === 404) throw new Error('The server that is running is an older copy. Stop it with Ctrl+C and run "npm start" again.');
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || 'The app could not save that.');
    this.set({ halves: r.halves || {} });
  }

  // The keyboard this page may use, asking the browser for it first if there is none. Needs a click.
  async one() {
    await this.chain;
    let list = await this.devices();
    if (!list.length) {
      await (await WebHidTransport.request()).close();
      list = await this.devices();
      if (!list.length) throw new Error(`The device you picked is not a ${this.target().name}.`);
    }
    return list;
  }

  // From a click: reads which half is plugged in.
  async check() {
    await this.one();
    this.sides.clear();
    await this.scan({ probe: true, now: true });
  }

  // From a click: marks the plugged-in half as 'left' or 'right' (null removes the mark).
  async mark(side) {
    const list = await this.one();
    if (list.length > 1) throw new Error('More than one of these keyboards is plugged in. Unplug one, so it is clear which half gets the mark.');
    const t = await WebHidTransport.open(list[0]);
    try { await new VialKeyboard(t, null).writeSide(this.target(), side); } finally { await t.close(); }
    this.sides.set(list[0], { checked: true, side, error: null });
    this.publish(list);
  }

  // While something else in the page (the write dialog) talks to the keyboard, the watch keeps its hands off.
  async pause() { this.paused++; await this.chain; }
  resume() {
    this.paused = Math.max(0, this.paused - 1);
    if (!this.paused) { this.sides.clear(); this.scan({ probe: true, now: true }); }
  }
}
