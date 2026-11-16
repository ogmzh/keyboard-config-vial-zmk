// Application state: the open keymap, undo history, the chosen target keyboard, and talking to the local server.

import { Keymap } from './core/keymap.js';
import { ZmkKeys } from './core/zmk-keys.js';
import { Qmk } from './core/qmk.js';
import { translate } from './core/translate.js';
import { packLayoutOptions } from './core/vil.js';
import { propTokens, walk } from './core/dts.js';
import { toast } from './ui/dom.js';

export async function api(method, url, body) {
  let res;
  try {
    const opts = { method };
    if (method !== 'GET') { opts.headers = { 'Content-Type': 'application/json', 'X-Keymap-Bridge': '1' }; opts.body = JSON.stringify(body ?? {}); }
    res = await fetch(url, opts);
  } catch {
    throw new Error('The Keymap Bridge server is not answering. Is "npm start" still running?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const DEFAULT_VIAL = { overrides: {}, layoutChoices: null, swapEncoders: false, macroDelays: 'explicit', applySettings: true, skipSettings: [], clearUnused: true };
const BUNDLED = { file: 'corne_choc_pro.keymap', info: 'corne_choc_pro.json', note: 'ogmzh/zmk-config at commit 71bcf77 (16 Nov 2026)' };

export class App {
  constructor(root) {
    this.root = root;
    this.target = localStorage.getItem('kb.target') || 'zmk';
    this.tab = 'keys';
    this.layer = 0;
    this.history = []; this.at = 0;
    this.server = null; this.source = null; this.km = null;
    this.vial = structuredClone(DEFAULT_VIAL);
    this.busy = null;
    this.onRender = null;
    this._tr = null;
  }

  async start() {
    const j = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`Could not load ${u}`); return r.json(); });
    const [zmkKeys, qmkCodes, target] = await Promise.all([j('data/zmk-keys.json'), j('data/qmk-keycodes.json'), j('data/targets/corne_mx_pro.json')]);
    this.zk = new ZmkKeys(zmkKeys);
    this.qmk = new Qmk(qmkCodes);
    this.vialTarget = target;
    await this.refreshServer();
    const repo = this.server && this.server.repo;
    if (repo && !repo.missing && repo.keymaps.length) {
      const want = repo.keymaps.find((k) => k.file === this.server.lastKeymap) || repo.keymaps.find((k) => /corne/.test(k.id)) || repo.keymaps[0];
      try { await this.openRepoKeymap(want.file); return; } catch (e) { toast(e.message, 'error'); }
    }
    await this.openBundled();
  }

  async refreshServer() {
    try { this.server = await api('GET', '/api/state'); } catch { this.server = null; }
    return this.server;
  }

  async openBundled() {
    const [text, info] = await Promise.all([fetch('/bundled/' + BUNDLED.file).then((r) => r.text()), fetch('/bundled/' + BUNDLED.info).then((r) => r.json())]);
    this.load(text, info, { kind: 'bundled', file: BUNDLED.file, note: BUNDLED.note }, null);
  }

  async openRepoKeymap(file) {
    const r = await api('GET', '/api/keymap?file=' + encodeURIComponent(file));
    this.load(r.text, r.layout, { kind: 'repo', file }, r.sidecar);
  }

  openText(text, name) { this.load(text, this.layoutInfo, { kind: 'file', file: name || 'pasted.keymap' }, null); }

  pickLayout(text, info) {
    if (!info || !info.layouts) return { layout: null, name: null };
    const m = /zmk,physical-layout\s*=\s*&(\w+)/.exec(text);
    const name = m && info.layouts[m[1]] ? m[1] : Object.keys(info.layouts)[0];
    return { layout: info.layouts[name].layout, name };
  }

  load(text, info, source, sidecar) {
    const { layout, name } = this.pickLayout(text, info);
    const km = new Keymap(text, layout, info ? info.sensors : []);
    this.km = km; this.layoutInfo = info; this.layoutName = name; this.source = source;
    this.keyboardName = (info && info.name) || source.file;
    this.savedText = text;
    this.history = [text]; this.at = 0;
    this.layer = 0;
    const stored = sidecar || JSON.parse(localStorage.getItem('kb.vial.' + source.file) || 'null');
    this.vial = { ...structuredClone(DEFAULT_VIAL), ...(stored || {}) };
    this.savedVial = JSON.stringify(this.vial);
    this._tr = null;
    this.render();
  }

  get dirty() { return this.history[this.at] !== this.savedText; }
  get vialDirty() { return JSON.stringify(this.vial) !== this.savedVial; }
  get text() { return this.history[this.at]; }

  // Applies an edit, records it for undo, redraws.
  commit(fn) {
    try {
      fn(this.km);
      const text = this.km.toString();
      new Keymap(text, this.km.layout, this.km.sensors); // must still parse
      if (text !== this.history[this.at]) { this.history = this.history.slice(0, this.at + 1); this.history.push(text); this.at++; if (this.history.length > 200) { this.history.shift(); this.at--; } }
    } catch (e) {
      toast(e.message, 'error');
      this.km = new Keymap(this.history[this.at], this.km.layout, this.km.sensors);
    }
    // re-read from text so every node reference is fresh
    this.km = new Keymap(this.history[this.at], this.km.layout, this.km.sensors);
    this.layer = Math.min(this.layer, this.km.layerNodes.length - 1);
    this._tr = null;
    this.render();
  }

  step(delta) {
    const to = this.at + delta;
    if (to < 0 || to >= this.history.length) return;
    this.at = to;
    this.km = new Keymap(this.history[this.at], this.km.layout, this.km.sensors);
    this.layer = Math.min(this.layer, this.km.layerNodes.length - 1);
    this._tr = null;
    this.render();
  }

  // Looks a node up again after a redraw (nodes are recreated on every commit).
  node(name) {
    let found = null;
    walk(this.km.doc, (n) => { if (!found && (n.labels[0] === name || n.name === name)) found = n; });
    return found;
  }

  setVial(patch) {
    this.vial = { ...this.vial, ...patch };
    localStorage.setItem('kb.vial.' + this.source.file, JSON.stringify(this.vial));
    this._tr = null;
    this.render();
  }

  setTarget(t) { this.target = t; localStorage.setItem('kb.target', t); this.render(); }

  // The keymap as the Vial keyboard will get it.
  get translation() {
    if (!this._tr) {
      this._tr = translate(this.km, this.zk, this.qmk, this.vialTarget, {
        overrides: this.vial.overrides, swapEncoders: this.vial.swapEncoders, macroDelays: this.vial.macroDelays,
        applySettings: this.vial.applySettings, skipSettings: this.vial.skipSettings,
        // null = leave the keyboard's own setting alone when writing over USB (a .vil file then says "all keys")
        layoutOptions: this.vial.layoutChoices ? packLayoutOptions(this.vial.layoutChoices, this.vialTarget.layoutOptions) : null,
      });
    }
    return this._tr;
  }

  async save() {
    if (this.source.kind !== 'repo') { toast('This copy is not connected to a folder. Use "Download" or connect your zmk-config folder.', 'info'); return false; }
    try {
      const body = { file: this.source.file };
      if (this.dirty) { body.text = this.text; body.expect = this.savedText; }
      if (this.vialDirty || Object.keys(this.vial.overrides).length) body.sidecar = this.vial;
      const r = await api('PUT', '/api/keymap', body);
      this.savedText = this.text; this.savedVial = JSON.stringify(this.vial);
      if (this.server && this.server.repo) this.server.repo.status = r.status;
      toast('Saved ' + r.written.join(' and '), 'ok');
      this.render();
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  }

  usedPositions(behaviorName) {
    const out = new Set();
    this.km.layers.forEach((l) => l.bindings.forEach((b, i) => { if (b.behavior === behaviorName) out.add(i); }));
    return out;
  }

  render() {
    if (this.onRender) this.onRender();
  }
}

export const tokensOf = (node, name) => propTokens(node, name) || [];
