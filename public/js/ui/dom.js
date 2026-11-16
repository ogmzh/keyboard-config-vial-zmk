// Tiny DOM helpers: element builder, dialogs, toasts, downloads.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

export const code = (text, cls = '') => h('code', { class: 'tok ' + cls }, text);

let openModals = 0;
export function modal({ title, body, footer, onClose, canClose, wide = false, cls = '' }) {
  const dialog = h('div', { class: `dialog ${wide ? 'wide' : ''} ${cls}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', { class: 'dialog-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onClick: () => close(null) }, '✕')),
    h('div', { class: 'dialog-body' }, body),
    footer ? h('footer', { class: 'dialog-foot' }, footer) : null);
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => { if (e.target === overlay) close(null); } }, dialog);
  const prev = document.activeElement;
  const onKey = (e) => { if (e.key === 'Escape' && overlay === document.body.lastElementChild) { e.stopPropagation(); close(null); } };
  let closed = false;
  function close(result) {
    if (closed) return;
    if (canClose && !canClose()) return;
    closed = true; openModals--;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    if (prev && prev.focus) prev.focus();
    if (onClose) onClose(result);
  }
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  openModals++;
  const first = dialog.querySelector('[autofocus], input, select, textarea, button.primary');
  if (first) setTimeout(() => first.focus(), 0);
  return { close, dialog, setBody: (b) => { const el = dialog.querySelector('.dialog-body'); el.replaceChildren(b); } };
}
export const anyModalOpen = () => openModals > 0;

export function confirmDialog(message, okLabel = 'OK', { danger = false, detail } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title: message,
      body: detail ? h('p', { class: 'muted' }, detail) : h('span'),
      footer: [
        h('button', { onClick: () => m.close(false) }, 'Cancel'),
        h('button', { class: danger ? 'danger' : 'primary', onClick: () => m.close(true) }, okLabel),
      ],
      onClose: (r) => resolve(!!r),
      cls: 'confirm',
    });
  });
}

export function promptDialog(title, { value = '', label = '', okLabel = 'OK', placeholder = '', hint } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, placeholder, autofocus: true, onKeydown: (e) => { if (e.key === 'Enter') m.close(input.value); } });
    const m = modal({
      title,
      body: h('label', { class: 'field' }, label ? h('span', null, label) : null, input, hint ? h('small', { class: 'muted' }, hint) : null),
      footer: [h('button', { onClick: () => m.close(null) }, 'Cancel'), h('button', { class: 'primary', onClick: () => m.close(input.value) }, okLabel)],
      onClose: (r) => resolve(r === null || r === undefined ? null : String(r)),
      cls: 'confirm',
    });
    setTimeout(() => input.select(), 0);
  });
}

let toastBox;
export function toast(message, kind = 'info', ms = 4200) {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(toastBox); }
  const el = h('div', { class: `toast ${kind}` }, message);
  toastBox.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? Math.max(ms, 8000) : ms);
}

export function download(name, text, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', null, label), control, hint ? h('small', { class: 'muted' }, hint) : null);
}
