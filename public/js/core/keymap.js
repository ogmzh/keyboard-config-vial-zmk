// The editable ZMK keymap: a thin, typed view over the devicetree document.
// Every setter rewrites only the property it touches, so a save produces a small diff.

import {
  parseDts, printDts, nodesOf, getProp, propString, propTokens, setPropText, removeProp, removeNode,
  addNode, renameNode, moveChild, walk, collectDefines, childIndent,
} from './dts.js';
import { BUILTIN_BEHAVIORS, BEHAVIOR_TYPES } from './behaviors.js';

export function parseBindings(tokens) {
  const out = [];
  for (const t of tokens || []) {
    if (t.startsWith('&')) out.push({ behavior: t.slice(1), params: [] });
    else if (out.length) out[out.length - 1].params.push(t);
  }
  return out;
}

export const bindingText = (b) => ['&' + b.behavior, ...b.params].join(' ');
export const sameBinding = (a, b) => bindingText(a) === bindingText(b);
const listText = (bindings) => bindings.map((b) => `<${bindingText(b)}>`).join(', ');
const lastLine = (s) => s.slice(s.lastIndexOf('\n') + 1);

export class Keymap {
  constructor(text, layout, sensors) {
    this.doc = parseDts(text);
    this.layout = layout || null;
    this.sensors = sensors || [];
    this.reindex();
  }

  toString() { return printDts(this.doc); }

  reindex() {
    this.defines = collectDefines(this.doc);
    this.keymapNode = null; this.combosNode = null; this.condNode = null;
    this.behaviorNodes = []; this.macroNodes = [];
    walk(this.doc, (node) => {
      const compat = propString(node, 'compatible');
      if (!compat) return;
      if (compat === 'zmk,keymap') this.keymapNode ??= node;
      else if (compat === 'zmk,combos') this.combosNode ??= node;
      else if (compat === 'zmk,conditional-layers') this.condNode ??= node;
      else if (compat.startsWith('zmk,behavior-macro')) this.macroNodes.push(node);
      else if (compat.startsWith('zmk,behavior-')) this.behaviorNodes.push(node);
    });
    if (!this.keymapNode) throw new Error('This file has no keymap (no node with compatible = "zmk,keymap").');
    this._custom = null;
  }

  // The top-level "/ { ... }" node that holds the keymap.
  get root() {
    let n = this.keymapNode;
    while (n.parent && n.parent.kind !== 'doc') n = n.parent;
    return n;
  }

  // ---------- behaviors registry ----------

  customBehaviors() {
    if (this._custom) return this._custom;
    const map = new Map();
    for (const node of [...this.behaviorNodes, ...this.macroNodes]) {
      const name = node.labels[0] || node.name;
      const compatible = propString(node, 'compatible');
      const type = BEHAVIOR_TYPES[compatible];
      map.set(name, {
        name, node, compatible, type, custom: true,
        macro: compatible.startsWith('zmk,behavior-macro'),
        title: type ? type.title : compatible.replace('zmk,behavior-', ''),
        params: null,
      });
    }
    this._custom = map;
    for (const info of map.values()) info.params = this._paramsFor(info, new Set());
    return map;
  }

  _paramsFor(info, seen) {
    if (seen.has(info.name)) return [];
    seen.add(info.name);
    const cellsTok = propTokens(info.node, '#binding-cells');
    const cells = cellsTok && /^\d+$/.test(cellsTok[0]) ? Number(cellsTok[0]) : (info.type ? info.type.cells : 0);
    const forwards = ['zmk,behavior-hold-tap', 'zmk,behavior-sticky-key', 'zmk,behavior-sensor-rotate-var'].includes(info.compatible);
    const refs = forwards ? parseBindings(propTokens(info.node, 'bindings')) : [];
    return Array.from({ length: cells }, (_, i) => {
      const ref = refs[i];
      if (!ref) return 'code';
      const target = this._custom.get(ref.behavior);
      const params = target ? (target.params || this._paramsFor(target, seen)) : (BUILTIN_BEHAVIORS[ref.behavior] || {}).params;
      return (params && params[0]) || 'code';
    });
  }

  behavior(name) {
    const custom = this.customBehaviors().get(name);
    if (custom) return custom;
    const b = BUILTIN_BEHAVIORS[name];
    if (b) return { name, builtin: true, ...b };
    return { name, unknown: true, title: name, params: null };
  }

  // Everything that can be picked for a key, built-ins first.
  allBehaviors({ macroControls = false, sensor = false } = {}) {
    const out = [];
    for (const [name, b] of Object.entries(BUILTIN_BEHAVIORS)) {
      if (b.macro && !macroControls) continue;
      if (b.sensor && !sensor) continue;
      out.push({ name, builtin: true, ...b });
    }
    for (const info of this.customBehaviors().values()) out.push(info);
    return out;
  }

  resolveLayer(token) {
    let t = String(token);
    for (let i = 0; i < 5 && !/^\d+$/.test(t) && this.defines.has(t); i++) t = this.defines.get(t).replace(/^\((.*)\)$/, '$1').trim();
    return /^\d+$/.test(t) ? Number(t) : null;
  }

  // ---------- layers ----------

  get layerNodes() { return nodesOf(this.keymapNode); }

  get layers() {
    return this.layerNodes.map((node, index) => ({
      index, node, name: node.name,
      label: propString(node, 'display-name') ?? propString(node, 'label') ?? node.name,
      bindings: parseBindings(propTokens(node, 'bindings')),
      sensorBindings: getProp(node, 'sensor-bindings') ? parseBindings(propTokens(node, 'sensor-bindings')) : null,
    }));
  }

  get keyCount() {
    if (this.layout) return this.layout.length;
    return Math.max(0, ...this.layers.map((l) => l.bindings.length));
  }

  _propIndent(node, name) {
    const p = getProp(node, name);
    return p ? lastLine(p.lead) : childIndent(node);
  }

  formatGrid(bindings, indent) {
    const texts = bindings.map(bindingText);
    const layout = this.layout;
    let rows = null;
    if (layout && layout.length === texts.length && layout.every((k) => Number.isInteger(k.row) && Number.isInteger(k.col))) {
      const rowMajor = layout.every((k, i) => i === 0 || k.row > layout[i - 1].row || (k.row === layout[i - 1].row && k.col > layout[i - 1].col));
      if (rowMajor) {
        const cols = [...new Set(layout.map((k) => k.col))].sort((a, b) => a - b);
        const rws = [...new Set(layout.map((k) => k.row))].sort((a, b) => a - b);
        const grid = rws.map(() => cols.map(() => ''));
        layout.forEach((k, i) => { grid[rws.indexOf(k.row)][cols.indexOf(k.col)] = texts[i]; });
        const widths = cols.map((_, c) => Math.max(...grid.map((r) => r[c].length)));
        rows = grid.map((r) => r.map((cell, c) => cell.padEnd(widths[c])).join('  ').replace(/\s+$/, ''));
      }
    }
    if (!rows) { rows = []; for (let i = 0; i < texts.length; i += 10) rows.push(texts.slice(i, i + 10).join('  ')); }
    return `<\n${rows.join('\n')}\n${indent}>`;
  }

  setLayerBindings(index, bindings) {
    const node = this.layerNodes[index];
    setPropText(node, 'bindings', this.formatGrid(bindings, this._propIndent(node, 'bindings')));
  }

  setBinding(layerIndex, pos, binding) {
    const bindings = this.layers[layerIndex].bindings;
    while (bindings.length < this.keyCount) bindings.push({ behavior: 'trans', params: [] });
    bindings[pos] = binding;
    this.setLayerBindings(layerIndex, bindings);
  }

  setSensorBindings(layerIndex, bindings) {
    const node = this.layerNodes[layerIndex];
    if (!bindings || !bindings.length) removeProp(node, 'sensor-bindings');
    else setPropText(node, 'sensor-bindings', `<${bindings.map(bindingText).join(' ')}>`);
  }

  setLayerLabel(index, label) {
    const node = this.layerNodes[index];
    const key = getProp(node, 'display-name') || !getProp(node, 'label') ? 'display-name' : 'label';
    if (label) setPropText(node, key, JSON.stringify(label));
    else removeProp(node, key);
  }

  uniqueNodeName(base, parent) {
    const taken = new Set();
    walk(this.doc, (n) => { taken.add(n.name); n.labels.forEach((l) => taken.add(l)); });
    Object.keys(BUILTIN_BEHAVIORS).forEach((k) => taken.add(k));
    let name = base; let k = 2;
    while (taken.has(name)) name = `${base}_${k++}`;
    return name;
  }

  addLayer(label) {
    const count = this.keyCount;
    const base = (label || 'layer').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'layer';
    const node = addNode(this.keymapNode, this.uniqueNodeName(/^[a-z_]/.test(base) ? base : 'layer_' + base));
    if (label) setPropText(node, 'display-name', JSON.stringify(label));
    const p = setPropText(node, 'bindings', this.formatGrid(Array.from({ length: count }, () => ({ behavior: 'trans', params: [] })), childIndent(node)));
    if (label) p.lead = '\n\n' + childIndent(node);
    return this.layerNodes.length - 1;
  }

  removeLayer(index) {
    const count = this.layerNodes.length;
    if (count <= 1) throw new Error('A keymap needs at least one layer.');
    removeNode(this.layerNodes[index]);
    this._remapLayers((i) => (i === index ? null : i > index ? i - 1 : i));
  }

  moveLayer(from, to) {
    const count = this.layerNodes.length;
    if (from === to || from < 0 || to < 0 || from >= count || to >= count) return;
    const order = Array.from({ length: count }, (_, i) => i);
    order.splice(to, 0, order.splice(from, 1)[0]);
    moveChild(this.keymapNode, this.layerNodes[from], to);
    this._remapLayers((i) => { const k = order.indexOf(i); return k < 0 ? i : k; });
  }

  // ---------- all bindings everywhere ----------

  _eachBindingsProp(fn) {
    walk(this.doc, (node) => {
      for (const name of ['bindings', 'sensor-bindings']) {
        const p = getProp(node, name);
        if (p) fn(node, name, parseBindings(propTokens(node, name)));
      }
    });
  }

  _writeBindings(node, name, bindings) {
    if (node.parent === this.keymapNode) {
      if (name === 'bindings') setPropText(node, name, this.formatGrid(bindings, this._propIndent(node, name)));
      else setPropText(node, name, `<${bindings.map(bindingText).join(' ')}>`);
    } else setPropText(node, name, this._listText(node, name, bindings));
  }

  _listText(node, name, bindings) {
    const one = listText(bindings);
    const indent = this._propIndent(node, name);
    if ((indent + name + ' = ' + one + ';').length <= 100 || bindings.length < 2) return one;
    return '\n' + bindings.map((b) => `${indent}    <${bindingText(b)}>`).join(',\n');
  }

  _mapAllBindings(fn) {
    this._eachBindingsProp((node, name, bindings) => {
      let changed = false;
      const next = bindings.map((b) => { const r = fn(b, node); if (r && r !== b) { changed = true; return r; } return b; });
      if (changed) this._writeBindings(node, name, next);
    });
  }

  _remapLayers(map) {
    this._custom = null;
    this._mapAllBindings((b) => {
      const info = this.behavior(b.behavior);
      if (!info.params) return b;
      let dead = false; let changed = false;
      const params = b.params.map((p, i) => {
        if (info.params[i] !== 'layer' || !/^\d+$/.test(p)) return p;
        const n = map(Number(p));
        if (n === null) { dead = true; return p; }
        if (n !== Number(p)) changed = true;
        return String(n);
      });
      if (dead) return { behavior: 'none', params: [] };
      return changed ? { behavior: b.behavior, params } : b;
    });
    const remapList = (node, name) => {
      const toks = propTokens(node, name);
      if (!toks) return true;
      const next = [];
      for (const t of toks) {
        if (!/^\d+$/.test(t)) { next.push(t); continue; }
        const n = map(Number(t));
        if (n !== null) next.push(String(n));
      }
      if (!next.length) return false;
      if (next.join(' ') !== toks.join(' ')) setPropText(node, name, `<${next.join(' ')}>`);
      return next.length === toks.length;
    };
    if (this.combosNode) for (const node of nodesOf(this.combosNode)) { if (!remapList(node, 'layers')) removeProp(node, 'layers'); }
    if (this.condNode) {
      for (const node of nodesOf(this.condNode)) {
        if (!remapList(node, 'if-layers') || !remapList(node, 'then-layer')) removeNode(node);
      }
    }
  }

  // ---------- generic typed fields ----------

  getField(node, field) {
    const toks = propTokens(node, field.name);
    switch (field.type) {
      case 'bool': return !!getProp(node, field.name);
      case 'int': return toks && toks.length ? (/^-?\d+$/.test(toks[0]) ? Number(toks[0]) : toks[0]) : undefined;
      case 'enum': case 'string': return propString(node, field.name);
      case 'refs': return parseBindings(toks).map((b) => b.behavior);
      case 'bindings': return parseBindings(toks);
      case 'positions': return (toks || []).filter((t) => /^\d+$/.test(t)).map(Number);
      case 'tokens': case 'codes': return toks || [];
      case 'mods': return toks && toks.length ? toks.join('|').replace(/[()\s]/g, '').split('|').filter(Boolean) : [];
      default: return toks;
    }
  }

  setField(node, field, value) {
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length) || Number.isNaN(value);
    this._custom = null;
    switch (field.type) {
      case 'bool': return value ? setPropText(node, field.name, null) : removeProp(node, field.name);
      case 'int': return empty ? removeProp(node, field.name) : setPropText(node, field.name, `<${value}>`);
      case 'enum': case 'string': return empty ? removeProp(node, field.name) : setPropText(node, field.name, JSON.stringify(value));
      case 'refs': return setPropText(node, field.name, value.map((r) => `<&${r}>`).join(', '));
      case 'bindings': return empty ? removeProp(node, field.name) : setPropText(node, field.name, this._listText(node, field.name, value));
      case 'positions': case 'tokens': case 'codes': return empty ? removeProp(node, field.name) : setPropText(node, field.name, `<${value.join(' ')}>`);
      case 'mods': return empty ? removeProp(node, field.name) : setPropText(node, field.name, `<(${value.join('|')})>`);
      default: throw new Error('Unknown field type ' + field.type);
    }
  }

  _container(name, compatible) {
    const root = this.root;
    let node = root.children.find((c) => c.kind === 'node' && c.name === name);
    if (!node) {
      node = addNode(root, name, { before: this.keymapNode.parent === root ? this.keymapNode : undefined });
      if (compatible) setPropText(node, 'compatible', JSON.stringify(compatible));
      if (this.keymapNode.parent === root && this.keymapNode.lead.split('\n').length < 3) this.keymapNode.lead = '\n\n' + lastLine(this.keymapNode.lead);
    }
    return node;
  }

  // ---------- combos ----------

  get combos() {
    if (!this.combosNode) return [];
    return nodesOf(this.combosNode).map((node) => ({
      node, name: node.name,
      bindings: parseBindings(propTokens(node, 'bindings')),
      keyPositions: (propTokens(node, 'key-positions') || []).filter((t) => /^\d+$/.test(t)).map(Number),
      layers: propTokens(node, 'layers') || [],
      timeoutMs: this.getField(node, { name: 'timeout-ms', type: 'int' }),
      requirePriorIdleMs: this.getField(node, { name: 'require-prior-idle-ms', type: 'int' }),
      slowRelease: !!getProp(node, 'slow-release'),
    }));
  }

  addCombo() {
    if (!this.combosNode) this.combosNode = this._container('combos', 'zmk,combos');
    const node = addNode(this.combosNode, this.uniqueNodeName('combo'));
    setPropText(node, 'bindings', '<&none>');
    setPropText(node, 'key-positions', '<0 1>');
    return node;
  }

  updateCombo(node, patch) {
    if ('name' in patch && patch.name && patch.name !== node.name) renameNode(node, patch.name);
    if ('bindings' in patch) setPropText(node, 'bindings', listText(patch.bindings));
    if ('keyPositions' in patch) setPropText(node, 'key-positions', `<${patch.keyPositions.join(' ')}>`);
    if ('layers' in patch) this.setField(node, { name: 'layers', type: 'tokens' }, patch.layers);
    if ('timeoutMs' in patch) this.setField(node, { name: 'timeout-ms', type: 'int' }, patch.timeoutMs);
    if ('requirePriorIdleMs' in patch) this.setField(node, { name: 'require-prior-idle-ms', type: 'int' }, patch.requirePriorIdleMs);
    if ('slowRelease' in patch) this.setField(node, { name: 'slow-release', type: 'bool' }, patch.slowRelease);
  }

  removeCombo(node) { removeNode(node); }
  removeConditionalLayer(node) { removeNode(node); }

  // ---------- conditional layers ----------

  get conditionalLayers() {
    if (!this.condNode) return [];
    return nodesOf(this.condNode).map((node) => ({
      node, name: node.name,
      ifLayers: propTokens(node, 'if-layers') || [],
      thenLayer: (propTokens(node, 'then-layer') || [])[0],
    }));
  }

  addConditionalLayer() {
    if (!this.condNode) this.condNode = this._container('conditional_layers', 'zmk,conditional-layers');
    const node = addNode(this.condNode, this.uniqueNodeName('tri_layer'));
    const n = this.layerNodes.length;
    setPropText(node, 'if-layers', `<${Math.min(1, n - 1)} ${Math.min(2, n - 1)}>`);
    setPropText(node, 'then-layer', `<${Math.min(3, n - 1)}>`);
    return node;
  }

  updateConditionalLayer(node, patch) {
    if ('name' in patch && patch.name && patch.name !== node.name) renameNode(node, patch.name);
    if ('ifLayers' in patch) setPropText(node, 'if-layers', `<${patch.ifLayers.join(' ')}>`);
    if ('thenLayer' in patch) setPropText(node, 'then-layer', `<${patch.thenLayer}>`);
  }

  // ---------- custom behaviors and macros ----------

  get behaviors() { return [...this.customBehaviors().values()].filter((b) => !b.macro); }
  get macros() { return [...this.customBehaviors().values()].filter((b) => b.macro); }

  addBehavior(compatible, wantedName) {
    const type = BEHAVIOR_TYPES[compatible];
    if (!type) throw new Error('Unknown behavior type ' + compatible);
    const container = this._container(type.macro ? 'macros' : 'behaviors');
    const name = this.uniqueNodeName(wantedName || type.prefix);
    const node = addNode(container, name, { label: name });
    setPropText(node, 'compatible', JSON.stringify(compatible));
    setPropText(node, '#binding-cells', `<${type.cells}>`);
    for (const f of type.fields) if (f.default !== undefined) this.setField(node, f, f.default);
    this.reindex();
    return node;
  }

  renameBehavior(node, newName) {
    const old = node.labels[0] || node.name;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) throw new Error('Use letters, digits and underscores, starting with a letter.');
    if (newName === old) return;
    if (this.customBehaviors().has(newName) || BUILTIN_BEHAVIORS[newName]) throw new Error(`"${newName}" is already used.`);
    renameNode(node, newName, newName);
    this._custom = null;
    this._mapAllBindings((b) => (b.behavior === old ? { behavior: newName, params: b.params } : b));
    this.reindex();
  }

  removeBehavior(node) {
    const old = node.labels[0] || node.name;
    removeNode(node);
    this.reindex();
    this._mapAllBindings((b) => (b.behavior === old ? { behavior: 'none', params: [] } : b));
  }

  usageCount(name) {
    let n = 0;
    this._eachBindingsProp((node, prop, bindings) => { n += bindings.filter((b) => b.behavior === name).length; });
    return n;
  }
}
