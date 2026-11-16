// Devicetree source parser/printer that keeps every byte it does not change.
//
// The document is a tree of items. Each item owns the whitespace and comments
// that come before it ("lead"), so printing an untouched tree gives back the
// exact original text, and editing one property only rewrites that property.

const DIRECTIVES = new Set([
  'include', 'define', 'undef', 'if', 'ifdef', 'ifndef', 'else', 'elif', 'endif', 'pragma', 'error', 'warning', 'line',
]);

export class DtsError extends Error {
  constructor(message, offset, text) {
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const col = offset - before.lastIndexOf('\n');
    super(`${message} (line ${line}, column ${col})`);
    this.line = line;
    this.col = col;
  }
}

export function parseDts(text) {
  let i = 0;
  const n = text.length;

  function trivia() {
    const start = i;
    for (;;) {
      const ch = text[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') i++;
      else if (ch === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; }
      else if (ch === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; }
      else break;
    }
    return text.slice(start, i);
  }

  function isDirective() {
    if (text[i] !== '#') return false;
    const m = /^#[ \t]*([a-z]+)\b/.exec(text.slice(i, i + 24));
    return !!m && DIRECTIVES.has(m[1]);
  }

  // Reads to the first '{', ';' or '}' that is not inside a string or a comment.
  function scanStatement() {
    for (; i < n; i++) {
      const ch = text[i];
      if (ch === '"') { i++; while (i < n && text[i] !== '"') { if (text[i] === '\\') i++; i++; } continue; }
      if (ch === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = (e < 0 ? n : e) - 1; continue; }
      if (ch === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = (e < 0 ? n : e + 2) - 1; continue; }
      if (ch === '{' || ch === ';' || ch === '}') return ch;
    }
    return '';
  }

  function items(parent) {
    const list = [];
    for (;;) {
      const lead = trivia();
      if (i >= n || text[i] === '}') return { list, tail: lead };
      const start = i;
      if (isDirective()) {
        for (;;) {
          const e = text.indexOf('\n', i);
          if (e < 0) { i = n; break; }
          const cont = /\\[ \t]*\r?$/.test(text.slice(i, e));
          i = e;
          if (!cont) break;
          i++;
        }
        list.push({ kind: 'raw', lead, src: text.slice(start, i), parent });
        continue;
      }
      const stop = scanStatement();
      if (stop === '{') {
        const header = text.slice(start, i + 1);
        i++;
        const node = makeNode(header, lead, parent);
        const inner = items(node);
        node.children = inner.list;
        node.tail = inner.tail;
        if (text[i] !== '}') throw new DtsError(`Missing "}" for node "${node.name}"`, start, text);
        const closeStart = i;
        i++;
        const save = i;
        while (i < n && /[ \t\r\n]/.test(text[i])) i++;
        if (text[i] === ';') i++; else i = save;
        node.close = text.slice(closeStart, i);
        list.push(node);
      } else if (stop === ';') {
        i++;
        const src = text.slice(start, i);
        if (src[0] === '/' ) list.push({ kind: 'raw', lead, src, parent });
        else list.push(makeProp(src, lead, parent));
      } else {
        throw new DtsError('Unexpected end of statement', start, text);
      }
    }
  }

  const doc = { kind: 'doc', children: [], tail: '' };
  const top = items(doc);
  if (i < n) throw new DtsError('Unexpected "}"', i, text);
  doc.children = top.list;
  doc.tail = top.tail;
  return doc;
}

function makeNode(header, lead, parent) {
  const head = stripComments(header.slice(0, -1)).trim();
  const parts = head.split(/\s+/).filter(Boolean);
  const labels = [];
  while (parts.length > 1 && parts[0].endsWith(':')) labels.push(parts.shift().slice(0, -1));
  let name = parts.join(' ');
  const m = /^(\w[\w,.+-]*):\s*(.*)$/.exec(name); // "label:name" with no space
  if (m && !name.startsWith('&')) { labels.push(m[1]); name = m[2]; }
  return { kind: 'node', lead, header, labels, name, children: [], tail: '', close: '};', parent };
}

function makeProp(src, lead, parent) {
  const body = src.slice(0, -1);
  const eq = topLevelIndexOf(body, '=');
  const name = stripComments(eq < 0 ? body : body.slice(0, eq)).trim();
  return { kind: 'prop', lead, src, name, parent, _value: undefined, _hasValue: eq >= 0 };
}

function topLevelIndexOf(s, target) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') { i++; while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; } continue; }
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === ']') depth--;
    else if (ch === target && depth === 0) return i;
  }
  return -1;
}

export function stripComments(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      const st = i; i++;
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; i++; }
      out += s.slice(st, i + 1);
    } else if (ch === '/' && s[i + 1] === '/') { const e = s.indexOf('\n', i); i = (e < 0 ? s.length : e) - 1; }
    else if (ch === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 1; out += ' '; }
    else out += ch;
  }
  return out;
}

// ---------- property values ----------

// Returns a list of chunks: {type:'cells', tokens:[..]} | {type:'string', value} | {type:'ref', value} | {type:'bytes', value}
export function propValue(prop) {
  if (prop._value !== undefined) return prop._value;
  if (!prop._hasValue) return (prop._value = []);
  const body = stripComments(prop.src.slice(0, -1));
  const text = body.slice(topLevelIndexOf(body, '=') + 1);
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s|,/.test(ch)) { i++; continue; }
    if (ch === '<') {
      let depth = 0; let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') depth--;
        else if (text[j] === '>' && depth === 0) break;
      }
      chunks.push({ type: 'cells', tokens: splitCells(text.slice(i + 1, j)) });
      i = j + 1;
    } else if (ch === '"') {
      let j = i + 1; let v = '';
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\') { v += text[j + 1]; j += 2; } else v += text[j++]; }
      chunks.push({ type: 'string', value: v });
      i = j + 1;
    } else if (ch === '[') {
      const j = text.indexOf(']', i);
      chunks.push({ type: 'bytes', value: text.slice(i + 1, j).trim() });
      i = j + 1;
    } else {
      const m = /^[^\s,]+/.exec(text.slice(i));
      chunks.push({ type: m[0][0] === '&' ? 'ref' : 'word', value: m[0] });
      i += m[0].length;
    }
  }
  return (prop._value = chunks);
}

// Splits "<&kp LS(A) 1>" contents into tokens, keeping parenthesised expressions whole.
export function splitCells(s) {
  const tokens = [];
  let cur = ''; let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth <= 0) { if (cur) tokens.push(cur); cur = ''; }
    else if (!/\s/.test(ch)) cur += ch;
    else if (depth > 0) { /* drop whitespace inside parens */ }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// ---------- tree helpers ----------

export const nodesOf = (parent) => parent.children.filter((c) => c.kind === 'node');
export const propsOf = (parent) => parent.children.filter((c) => c.kind === 'prop');
export const getProp = (node, name) => node.children.find((c) => c.kind === 'prop' && c.name === name);
export const getChild = (node, name) => node.children.find((c) => c.kind === 'node' && c.name === name);

export function propString(node, name) {
  const p = getProp(node, name);
  if (!p) return undefined;
  const s = propValue(p).find((c) => c.type === 'string');
  return s ? s.value : undefined;
}

export function propTokens(node, name) {
  const p = getProp(node, name);
  if (!p) return undefined;
  const out = [];
  for (const c of propValue(p)) {
    if (c.type === 'cells') out.push(...c.tokens);
    else if (c.type === 'ref' || c.type === 'word') out.push(c.value);
  }
  return out;
}

export function walk(parent, fn) {
  for (const c of parent.children) {
    if (c.kind === 'node') { fn(c); walk(c, fn); }
  }
}

function lastLine(s) { const k = s.lastIndexOf('\n'); return k < 0 ? null : s.slice(k + 1); }

export function indentOf(node) {
  // indentation of the node's own first line
  const own = lastLine(node.lead || '');
  if (own !== null && /^[ \t]*$/.test(own)) return own;
  return '';
}

export function childIndent(node) {
  for (const c of node.children) {
    const l = lastLine(c.lead || '');
    if (l !== null && /^[ \t]*$/.test(l)) return l;
  }
  if (node.kind === 'doc') return '';
  return indentOf(node) + '    ';
}

// Sets (or creates) a property from its text after the name, e.g. setPropText(node, 'layers', '<0 1>').
// Pass valueText === null for a boolean (present, no value) property.
export function setPropText(node, name, valueText) {
  const src = valueText === null ? `${name};` : `${name} =${valueText.startsWith('\n') ? '' : ' '}${valueText};`;
  let p = getProp(node, name);
  if (p) {
    if (p.src === src) return p;
    p.src = src; p._value = undefined; p._hasValue = valueText !== null;
    return p;
  }
  p = { kind: 'prop', lead: '\n' + childIndent(node), src, name, parent: node, _value: undefined, _hasValue: valueText !== null };
  // properties go before the first child node, after the last existing property
  let at = node.children.length;
  const firstNode = node.children.findIndex((c) => c.kind === 'node');
  if (firstNode >= 0) at = firstNode;
  node.children.splice(at, 0, p);
  if (!node.tail || !node.tail.includes('\n')) node.tail = '\n' + indentOf(node);
  return p;
}

export function removeProp(node, name) {
  const idx = node.children.findIndex((c) => c.kind === 'prop' && c.name === name);
  if (idx >= 0) removeItem(node, idx);
}

export function removeItem(parent, idx) {
  const [gone] = parent.children.splice(idx, 1);
  // keep comments that were attached above the removed item only if they are separated by a blank line
  const next = parent.children[idx];
  if (next && !next.lead.includes('\n') && gone.lead.includes('\n')) next.lead = gone.lead;
  return gone;
}

export function removeNode(node) {
  const idx = node.parent.children.indexOf(node);
  if (idx >= 0) removeItem(node.parent, idx);
}

// Appends a new empty child node and returns it.
export function addNode(parent, name, { label, blankLineBefore = true, before } = {}) {
  const ind = childIndent(parent);
  const hasItems = parent.children.length > 0;
  const lead = (hasItems && blankLineBefore ? '\n\n' : '\n') + ind;
  const header = `${label ? label + ': ' : ''}${name} {`;
  const node = { kind: 'node', lead, header, labels: label ? [label] : [], name, children: [], tail: '\n' + ind, close: '};', parent };
  let at = parent.children.length;
  if (before) { const k = parent.children.indexOf(before); if (k >= 0) at = k; }
  if (at < parent.children.length && at === 0) {
    // inserting first: take over the next item's lead so the file start stays tidy
    node.lead = parent.children[0].lead || '\n' + ind;
    parent.children[0].lead = '\n\n' + ind;
  }
  parent.children.splice(at, 0, node);
  if (parent.kind !== 'doc' && (!parent.tail || !parent.tail.includes('\n'))) parent.tail = '\n' + indentOf(parent);
  return node;
}

export function renameNode(node, name, label) {
  const hasLabel = label !== undefined ? !!label : node.labels.length > 0;
  const lbl = label !== undefined ? label : node.labels[0];
  node.name = name;
  node.labels = hasLabel ? [lbl] : [];
  node.header = `${hasLabel ? lbl + ': ' : ''}${name} {`;
}

export function moveChild(parent, node, toIndexAmongNodes) {
  const nodes = nodesOf(parent);
  const from = nodes.indexOf(node);
  if (from < 0 || from === toIndexAmongNodes) return;
  // swap leads so comments/blank lines stay attached to positions rather than jumping around
  const leads = nodes.map((x) => x.lead);
  nodes.splice(from, 1);
  nodes.splice(toIndexAmongNodes, 0, node);
  nodes.forEach((x, k) => { x.lead = leads[k]; });
  let k = 0;
  parent.children = parent.children.map((c) => (c.kind === 'node' ? nodes[k++] : c));
}

// ---------- printing ----------

export function printDts(doc) {
  let out = '';
  const emit = (item) => {
    out += item.lead;
    if (item.kind === 'node') {
      out += item.header;
      item.children.forEach(emit);
      out += item.tail + item.close;
    } else out += item.src;
  };
  doc.children.forEach(emit);
  return out + doc.tail;
}

// Object-like "#define NAME value" lines, used to resolve layer names like "&mo LOWER".
export function collectDefines(doc) {
  const defs = new Map();
  const visit = (parent) => {
    for (const c of parent.children) {
      if (c.kind === 'raw') {
        const m = /^#[ \t]*define[ \t]+(\w+)[ \t]+(.+?)\s*$/s.exec(stripComments(c.src));
        if (m) defs.set(m[1], m[2].trim());
      } else if (c.kind === 'node') visit(c);
    }
  };
  visit(doc);
  return defs;
}
