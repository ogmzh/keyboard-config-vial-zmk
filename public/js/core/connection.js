// Works out whether each keyboard is plugged in, and which half, from what the app can see:
//   usb      the server's list of USB devices (macOS only)
//   volumes  the bootloader drives, each with what the server read from the firmware on it
//   hid      for the Vial keyboard, what the browser itself read from the keyboard (see watch.js)
//   halves   for the Vial keyboard, which serial number you said is the left half and which the right
// Plain functions with no browser or server code in them, so the tests and the server can use them too.

const ZMK = { vendorId: 0x1D50, productId: 0x615E, vendor: 'ZMK Project' };
const NO_USB = { supported: false, devices: [] };
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const isReset = (name) => /settings.?reset/i.test(name || '');

// "Corne Choc Pro BT" (the layout file) and "Corne Choc Pro" (what the left half calls itself on USB) are one keyboard.
export function sameKeyboard(a, b) {
  const x = words(a); const y = words(b);
  return !!x && !!y && (x === y || x.startsWith(y + ' ') || y.startsWith(x + ' '));
}

const isZmk = (d) => (d.vendorId === ZMK.vendorId && d.productId === ZMK.productId) || d.vendor === ZMK.vendor;

// Is this USB device the Vial keyboard? Keebart's firmware builds do not agree on the name or the product id:
// the source says "Corne MX Pro", id 4, and a real keyboard says "My Corne MX", id 0. So this goes by the part
// of the name they share, and by the ids only when there is no name. This is for the indicator only: before
// anything is written, the keyboard is asked for its own Vial id (see check() in vial-hid.js).
export function isVialDevice(d, target) {
  const u = target.usb;
  if (!u) return false;
  if (d.vendor && u.vendor && words(d.vendor) !== words(u.vendor)) return false;
  const name = words(d.product);
  if (!name) return d.vendorId === u.vendorId && (u.productIds.includes(d.productId) || d.productId === u.miniProductId);
  return ` ${name} `.includes(` ${words(u.nameHas || u.product)} `);
}

// What to draw for each half: off, on (running), boot (bootloader mode), maybe (something is there, side unknown).
const glyph = (left, right, unknown) => ({
  left: left !== 'off' ? left : unknown ? 'maybe' : 'off',
  right: right !== 'off' ? right : unknown ? 'maybe' : 'off',
});

function serverTrouble(conn) {
  if (conn.server === 'unknown') return { label: 'Looking…', tone: 'muted', line: 'Looking for the keyboard…' };
  if (conn.server === 'old') return { label: 'Restart the app', tone: 'warn', line: 'The server that is running is an older copy: it cannot list USB devices or tell which half is on a drive. Stop it with Ctrl+C and run "npm start" again.' };
  if (conn.server === 'down') return { label: 'Server not running', tone: 'warn', line: 'The Keymap Bridge server is not answering. Is "npm start" still running?' };
  return null;
}

// ---------- the ZMK keyboard: both halves run their own firmware and show up on USB on their own ----------
export function zmkStatus(conn, keyboardName) {
  const usb = conn.usb || NO_USB;
  const zmk = usb.devices.filter(isZmk);
  const left = zmk.filter((d) => sameKeyboard(d.product, keyboardName));
  const right = zmk.filter((d) => !d.product);
  const reset = zmk.filter((d) => isReset(d.product));
  const others = zmk.filter((d) => d.product && !left.includes(d) && !reset.includes(d));
  const drives = (conn.volumes || []).filter((v) => v.chip && v.chip.startsWith('nRF52')).map((v) => driveInfo(v, keyboardName));

  const phrases = []; const lines = [];
  if (left.length && right.length) phrases.push('both halves connected');
  else if (left.length) phrases.push('left half connected');
  else if (right.length) phrases.push('right half connected');
  if (left.length) lines.push({ tone: 'ok', text: `Left half: plugged in and running. It calls itself "${left[0].product}".` });
  if (right.length) lines.push({ tone: 'ok', text: 'Right half: plugged in and running. A right half does not say which keyboard it belongs to.' });
  for (let i = 0; i < reset.length; i++) {
    phrases.push('a half with the settings reset on it');
    lines.push({ tone: 'warn', text: 'A half is running the settings-reset firmware. Flash its normal firmware next.' });
  }
  for (const d of drives) {
    if (d.other) { phrases.push('another keyboard in bootloader mode'); lines.push({ tone: 'warn', text: `Drive ${d.name}: the left half of another keyboard (${d.other}), not the ${keyboardName}.` }); continue; }
    if (d.pending) { phrases.push('a half in bootloader mode'); lines.push({ tone: 'boot', text: `Drive ${d.name}: a half in bootloader mode. Reading which one…` }); continue; }
    if (!d.side) { phrases.push('a half in bootloader mode'); lines.push({ tone: 'boot', text: `Drive ${d.name}: a half in bootloader mode. The firmware on it does not say which half it is.` }); continue; }
    phrases.push(`${d.side} half in bootloader mode`);
    lines.push({ tone: 'boot', text: `Drive ${d.name}: the ${d.side} half, in bootloader mode${d.reset ? ', with the settings-reset firmware on it' : ''}.${d.side === 'right' ? ' A right half does not say which keyboard it belongs to.' : ''}` });
  }
  for (const d of others) lines.push({ tone: 'muted', text: `Another ZMK keyboard is plugged in: ${d.product}.` });

  const trouble = serverTrouble(conn);
  let label = phrases.length ? cap(phrases.join(', ')) : 'Not connected by USB';
  if (trouble) {
    if (!phrases.length) label = trouble.label;
    lines.push({ tone: trouble.tone, text: trouble.line });
  } else if (!phrases.length) {
    if (usb.supported) lines.push({ tone: 'muted', text: 'No half is plugged in by USB. This shows the cable only: the keyboard can still be working over Bluetooth.' });
    else { label = 'Not in bootloader mode'; lines.push({ tone: 'muted', text: 'On this system the app cannot list USB devices. It notices a half only once it is in bootloader mode.' }); }
  }
  const unknown = reset.length + drives.filter((d) => !d.side && !d.other).length;
  const state = (side, running) => (running.length ? 'on' : drives.some((d) => d.side === side && !d.other) ? 'boot' : 'off');
  const warn = reset.length || drives.some((d) => d.other) || (trouble && trouble.tone === 'warn');
  return {
    kind: 'zmk', label, lines, drives, actions: [],
    glyph: glyph(state('left', left), state('right', right), unknown),
    tone: warn ? 'warn' : drives.length ? 'boot' : phrases.length ? 'ok' : 'off',
  };
}

// What a bootloader drive holds, as far as the firmware on it tells.
export function driveInfo(volume, keyboardName) {
  const fw = volume.firmware || null;
  const pending = !!(fw && fw.pending);
  const known = !!fw && !pending && fw.zmk !== false;
  return {
    name: volume.name, path: volume.path, pending,
    side: known ? fw.side || null : null,
    reset: known && !!fw.reset,
    // the left half carries the keyboard's name; when that is another keyboard's name, say so
    other: known && fw.product && !isReset(fw.product) && !sameKeyboard(fw.product, keyboardName) ? fw.product : null,
  };
}

// ---------- the Vial keyboard: one half is on USB, the other hangs off it; both look the same on USB ----------
export function vialStatus(conn, target) {
  const usb = conn.usb || NO_USB;
  const hid = conn.hid || { supported: false, devices: [] };
  const short = target.name.replace(/^Keebart /, '');
  const seen = usb.devices.filter((d) => isVialDevice(d, target));
  const known = hid.devices || [];
  const count = Math.max(seen.length, known.length);
  const mini = [...seen, ...known].some((d) => d.productId === target.usb.miniProductId);
  const boot = (conn.volumes || []).filter((v) => v.chip === target.usb.bootDrive);

  // Each half has its own serial number when the firmware passes on the chip's. Then the app only has to be told once.
  const halves = conn.halves || {};
  const named = (d) => (Object.hasOwn(halves, d.serial) && ['left', 'right'].includes(halves[d.serial]) ? halves[d.serial] : null);
  const serials = seen.filter((d) => d.serial);

  const phrases = []; const lines = []; const actions = [];
  let left = 'off'; let right = 'off'; let unknown = 0; let warn = false; let serial = null;
  if (mini) {
    phrases.push('Mini connected'); unknown = 1; warn = true;
    lines.push({ tone: 'warn', text: `This is the ${short} Mini (5 columns). The app only knows the 6-column board and will not write to it.` });
  } else if (serials.length) {
    const sides = serials.map(named).filter(Boolean);
    if (sides.includes('left')) left = 'on';
    if (sides.includes('right')) right = 'on';
    unknown = Math.max(0, seen.length - sides.length);
    if (sides.length) phrases.push(left === 'on' && right === 'on' ? 'both halves connected' : `${sides[0]} half connected`);
    else phrases.push('connected, half not named');
    for (const s of new Set(sides)) lines.push({ tone: 'ok', text: `The USB cable is in the ${s} half. The keymap lives in the half the cable is in; the other half works through the link cable, which the app cannot see.` });
    if (unknown) lines.push({ tone: 'muted', text: 'Both halves look the same over USB, but each has its own serial number. Look at which half the cable is in and tell the app once; it knows that half from then on. Nothing is written to the keyboard for this.' });
    if (seen.length === 1) { actions.push('name'); serial = serials[0].serial; }
    else lines.push({ tone: 'muted', text: 'More than one is plugged in. Unplug one to name a half.' });
  } else if (count) {
    const read = known.filter((d) => d.checked && !d.error);
    const sides = read.map((d) => d.side).filter(Boolean);
    const failed = known.find((d) => d.checked && d.error);
    if (sides.includes('left')) left = 'on';
    if (sides.includes('right')) right = 'on';
    unknown = Math.max(0, count - sides.length);
    if (sides.length) {
      phrases.push(left === 'on' && right === 'on' ? 'both halves connected' : `${sides[0]} half connected`);
      for (const s of new Set(sides)) lines.push({ tone: 'ok', text: `The USB cable is in the ${s} half. The keymap lives in the half the cable is in; the other half works through the link cable, which the app cannot see.` });
      actions.push('mark');
    } else if (failed) {
      phrases.push('connected, half not read'); warn = true;
      lines.push({ tone: 'warn', text: failed.error });
      actions.push('check');
    } else if (read.length) {
      phrases.push('connected, half not marked');
      lines.push({ tone: 'muted', text: 'Both halves look the same over USB. Look at which half the cable is in and mark it once; the app recognises that half from then on.' });
      actions.push('mark');
    } else {
      phrases.push('connected, half not checked');
      if (hid.supported) {
        lines.push({ tone: 'muted', text: 'To see which half it is, the browser has to be allowed to talk to the keyboard. It asks again each time the keyboard is plugged in, because the keyboard has no serial number.' });
        actions.push('check');
      } else {
        lines.push({ tone: 'muted', text: 'This browser cannot talk to the keyboard (no WebHID), so the app cannot tell which half it is. Chrome, Edge and Brave can.' });
      }
    }
  }
  for (const v of boot) {
    phrases.push('a half in bootloader mode'); unknown++;
    lines.push({ tone: 'boot', text: `Drive ${v.name}: a board in bootloader mode. This kind of drive does not say which keyboard or half it is.` });
  }

  const trouble = serverTrouble(conn);
  let label = phrases.length ? cap(phrases.join(', ')) : 'Not connected';
  if (trouble) {
    if (!phrases.length) label = trouble.label;
    lines.push({ tone: trouble.tone, text: trouble.line });
    if (trouble.tone === 'warn') warn = true;
  }
  if (!phrases.length && !(trouble && trouble.tone === 'muted')) {
    if (usb.supported) lines.push({ tone: 'muted', text: 'Not plugged in.' });
    else if (hid.supported) {
      // without the server's USB list, the browser is the only way to find the keyboard
      lines.push({ tone: 'muted', text: 'The app cannot list USB devices right now. Plug the keyboard in and let the browser look for it.' });
      actions.push('check');
    } else if (!trouble) lines.push({ tone: 'muted', text: 'The app cannot see USB keyboards on this system with this browser.' });
  }
  return {
    kind: 'vial', label, lines, actions, serial,
    marked: left === 'on' ? 'left' : right === 'on' ? 'right' : null,
    glyph: glyph(left, right, unknown),
    tone: warn ? 'warn' : boot.length ? 'boot' : count ? (unknown ? 'maybe' : 'ok') : 'off',
  };
}
