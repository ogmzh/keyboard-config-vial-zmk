import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIoreg, uf2Payload, uf2Problem, firmwareFacts } from '../lib/usb.mjs';
import { zmkStatus, vialStatus, sameKeyboard, isVialDevice, driveInfo } from '../public/js/core/connection.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = JSON.parse(fs.readFileSync(path.join(root, 'public/data/targets/corne_mx_pro.json'), 'utf8'));
const NAME = 'Corne Choc Pro BT';

// ---------- the macOS USB list ----------
const IOREG = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 30>
  +-o AppleT8103USBXHCI@00000000  <class AppleT8103USBXHCI, id 0x100000324, registered, matched, active, busy 0 (5 ms), retain 60>
  | {
  |   "locationID" = 0
  | }
  |
  +-o AppleT8103USBXHCI@01000000  <class AppleT8103USBXHCI, id 0x100000320, registered, matched, active, busy 0 (9 ms), retain 78>
    | {
    |   "locationID" = 16777216
    | }
    |
    +-o Corne Choc Pro@01100000  <class IOUSBHostDevice, id 0x100003a01, registered, matched, active, busy 0 (3 ms), retain 30>
    |   {
    |     "idProduct" = 24926
    |     "USB Product Name" = "Corne Choc Pro"
    |     "USB Vendor Name" = "ZMK Project"
    |     "idVendor" = 7504
    |     "USB Serial Number" = "A1B2C3D4E5F60718"
    |     "locationID" = 17825792
    |   }
    |
    +-o IOUSBHostDevice@01200000  <class IOUSBHostDevice, id 0x100003a40, registered, matched, active, busy 0 (3 ms), retain 30>
    |   {
    |     "idProduct" = 24926
    |     "USB Vendor Name" = "ZMK Project"
    |     "idVendor" = 7504
    |     "locationID" = 18874368
    |   }
    |
    +-o Corne MX Pro@01300000  <class IOUSBHostDevice, id 0x100003a77, registered, matched, active, busy 0 (3 ms), retain 30>
        {
          "idProduct" = 4
          "kUSBProductString" = "Corne MX Pro"
          "kUSBVendorString" = "Keebart"
          "idVendor" = 65261
          "locationID" = 19922944
        }
`;

test('the macOS USB list is read into devices', () => {
  const devs = parseIoreg(IOREG);
  assert.equal(devs.length, 3); // the two USB controllers have no vendor id and are left out
  assert.deepEqual(devs[0], { vendorId: 0x1D50, productId: 0x615E, product: 'Corne Choc Pro', vendor: 'ZMK Project', serial: 'A1B2C3D4E5F60718', location: 17825792 });
  assert.equal(devs[1].product, '');
  assert.equal(devs[1].vendor, 'ZMK Project');
  assert.deepEqual([devs[2].vendorId, devs[2].productId, devs[2].product, devs[2].vendor], [0xFEED, 4, 'Corne MX Pro', 'Keebart']);
  assert.deepEqual(parseIoreg(''), []);
});

// ---------- which half a firmware image is for ----------
// A UF2 file made of 512-byte blocks, as the bootloader drive and the GitHub build produce them.
function uf2(payload) {
  const blocks = [];
  const total = Math.ceil(payload.length / 256);
  for (let off = 0; off < payload.length; off += 256) {
    const b = Buffer.alloc(512);
    b.writeUInt32LE(0x0A324655, 0); b.writeUInt32LE(0x9E5D5157, 4); b.writeUInt32LE(0x2000, 8);
    b.writeUInt32LE(0x26000 + off, 12); b.writeUInt32LE(Math.min(256, payload.length - off), 16);
    b.writeUInt32LE(off / 256, 20); b.writeUInt32LE(total, 24);
    b.writeUInt32LE(0xADA52840, 28);
    payload.copy(b, 32, off, off + 256);
    b.writeUInt32LE(0x0AB16F30, 508);
    blocks.push(b);
  }
  return Buffer.concat(blocks);
}
// The USB text table of a ZMK image: maker, then product, each as [length, 3, characters, room to widen them].
const usbText = (s) => Buffer.concat([Buffer.from([2 + 2 * s.length, 3]), Buffer.from(s, 'latin1'), Buffer.alloc(s.length)]);
const image = (...parts) => Buffer.concat([Buffer.alloc(700, 0x55), ...parts.map((p) => (typeof p === 'string' ? Buffer.from(p + '\0', 'latin1') : p)), Buffer.alloc(300, 0xAA)]);
const LEFT = image('ble/peripheral_addresses', 'ble_central', 'encoder_left_a', usbText('ZMK Project'), usbText('Corne Choc Pro'));
const RIGHT = image('Split Peripheral Notification Queue', 'ble_peripheral', 'encoder_right_a', usbText('ZMK Project'), usbText(''));
const RESET_LEFT = image('settings_reset', 'encoder_left_a', usbText('ZMK Project'), usbText('SETTINGS RESET'));

test('a firmware image says which half it is for', () => {
  assert.deepEqual(uf2Payload(uf2(LEFT)), LEFT);
  assert.deepEqual(firmwareFacts(uf2Payload(uf2(LEFT))), { zmk: true, role: 'central', side: 'left', reset: false, product: 'Corne Choc Pro' });
  assert.deepEqual(firmwareFacts(uf2Payload(uf2(RIGHT))), { zmk: true, role: 'peripheral', side: 'right', reset: false, product: '' });
  assert.deepEqual(firmwareFacts(RESET_LEFT), { zmk: true, role: null, side: 'left', reset: true, product: 'SETTINGS RESET' });
  // not ZMK at all (other firmware, or an empty chip): no guess
  assert.deepEqual(firmwareFacts(Buffer.alloc(4096, 0xFF)), { zmk: false, role: null, side: null, reset: false, product: null });
  assert.equal(uf2Payload(Buffer.from('not a uf2 file')).length, 0);
});

test('firmware files in the firmware folder: the name and the contents agree about the half', (t) => {
  const dir = path.join(root, 'firmware');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.uf2')) : [];
  if (!files.length) { t.skip('no firmware downloaded'); return; }
  for (const f of files) {
    const buf = fs.readFileSync(path.join(dir, String(f)));
    assert.equal(uf2Problem(buf), null, String(f));
    const facts = firmwareFacts(uf2Payload(buf));
    const byName = /right/i.test(f) ? 'right' : /left/i.test(f) ? 'left' : null;
    if (facts.side && byName) assert.equal(facts.side, byName, String(f));
  }
});

test('a firmware file is checked block by block before it may be copied', () => {
  const whole = uf2(LEFT);
  const blocks = whole.length / 512;
  assert.ok(blocks >= 4);
  assert.equal(uf2Problem(whole), null);
  const edit = (fn) => { const b = Buffer.from(whole); fn(b); return uf2Problem(b); };
  // cut short by a failed download: only a header, half a block, or whole blocks missing at the end
  assert.match(uf2Problem(whole.subarray(0, 32)), /part of it is missing/);
  assert.match(uf2Problem(whole.subarray(0, whole.length - 100)), /part of it is missing/);
  assert.match(uf2Problem(whole.subarray(0, whole.length - 512)), /blocks are missing/);
  assert.match(uf2Problem(Buffer.alloc(0)), /missing/);
  // two files glued together, or a block that is not UF2 at all
  assert.match(uf2Problem(Buffer.concat([whole, whole])), /out of order or blocks are missing/);
  assert.match(edit((b) => b.writeUInt32LE(0, 512 + 508)), /block 2 of \d+ is not a UF2 block/);
  // a block for another chip, or one aimed at the bootloader or at the part that starts it
  assert.match(edit((b) => b.writeUInt32LE(0xE48BFF56, 512 + 28)), /different kind of chip/);
  assert.match(edit((b) => b.writeUInt32LE(0xF4000, 512 + 12)), /outside the application area/);
  assert.match(edit((b) => b.writeUInt32LE(0, 12)), /outside the application area/);
  assert.match(edit((b) => b.writeUInt32LE(0x10001000, 2 * 512 + 12)), /outside the application area/);
  assert.match(edit((b) => b.writeUInt32LE(0x2001, 8)), /not being firmware/);
  assert.match(edit((b) => b.writeUInt32LE(477, 16)), /impossible size/);
});

// ---------- the indicator ----------
const zmkDev = (product) => ({ vendorId: 0x1D50, productId: 0x615E, product, vendor: 'ZMK Project', serial: '', location: 1 });
const vialDev = (productId = 4) => ({ vendorId: 0xFEED, productId, product: 'Corne MX Pro', vendor: 'Keebart', serial: '', location: 2 });
const SERIAL = 'E46064D700000001'; // made up, in the shape a real one has
const realDev = (serial = SERIAL) => ({ vendorId: 0xFEED, productId: 0, product: 'My Corne MX', vendor: 'Keebart', serial, location: 1048576 });
const conn = (o = {}) => ({ server: 'ok', usb: { supported: true, devices: [] }, volumes: [], hid: { supported: true, devices: [] }, ...o });
const usb = (...devices) => ({ supported: true, devices });
const drive = (firmware, chip = 'nRF52840') => ({ path: '/Volumes/BOOT', name: 'BOOT', model: '', board: '', chip, firmware });
const facts = (side, product, more = {}) => ({ zmk: true, role: side === 'left' ? 'central' : 'peripheral', side, reset: false, product, ...more });

test('keyboard names are matched loosely, never across keyboards', () => {
  assert.ok(sameKeyboard('Corne Choc Pro BT', 'Corne Choc Pro'));
  assert.ok(sameKeyboard('corne_choc_pro.keymap', 'Corne Choc Pro'));
  assert.ok(!sameKeyboard('Corne Choc Pro BT', 'Sofle Choc Pro'));
  assert.ok(!sameKeyboard('Corne Choc Pro BT', ''));
  assert.ok(isVialDevice(vialDev(), target) && isVialDevice({ vendorId: 0xFEED, productId: 4, product: '' }, target) && isVialDevice({ vendorId: 1, productId: 1, product: 'Keebart Corne MX Pro' }, target));
  assert.ok(!isVialDevice({ vendorId: 0xFEED, productId: 4, product: 'Some Other Board' }, target) && !isVialDevice(zmkDev('Corne Choc Pro'), target));
  // what a real keyboard announces (2026-11): another name and product id than the firmware source has
  assert.ok(isVialDevice(realDev(), target), 'as macOS lists it');
  assert.ok(isVialDevice({ vendorId: 0xFEED, productId: 0, product: 'My Corne MX' }, target), 'as the browser lists it');
  assert.ok(!isVialDevice({ ...realDev(), vendor: 'Somebody Else' }, target) && !isVialDevice({ vendorId: 0xFEED, productId: 0, product: '' }, target));
  assert.ok(!isVialDevice({ vendorId: 0xFEED, productId: 0, product: 'Corne MXL' }, target));
});

test('Vial keyboard with a serial number: named once, known from then on', () => {
  // plugged in, never named: no browser permission is needed, the app offers the two names
  let s = vialStatus(conn({ usb: usb(realDev()) }), target);
  assert.deepEqual([s.label, s.tone, s.glyph, s.actions, s.serial, s.marked], ['Connected, half not named', 'maybe', { left: 'maybe', right: 'maybe' }, ['name'], SERIAL, null]);

  s = vialStatus(conn({ usb: usb(realDev()), halves: { [SERIAL]: 'left' } }), target);
  assert.deepEqual([s.label, s.tone, s.glyph, s.actions, s.marked], ['Left half connected', 'ok', { left: 'on', right: 'off' }, ['name'], 'left']);

  // the other half has another serial number
  s = vialStatus(conn({ usb: usb(realDev('E46064D700000000')), halves: { [SERIAL]: 'left', E46064D700000000: 'right' } }), target);
  assert.deepEqual([s.label, s.glyph, s.marked], ['Right half connected', { left: 'off', right: 'on' }, 'right']);
  s = vialStatus(conn({ usb: usb(realDev('E46064D700000000')), halves: { [SERIAL]: 'left' } }), target);
  assert.equal(s.label, 'Connected, half not named');

  // a name for a serial number that is not plugged in changes nothing; junk in the settings file is ignored
  assert.equal(vialStatus(conn({ halves: { [SERIAL]: 'left' } }), target).label, 'Not connected');
  assert.equal(vialStatus(conn({ usb: usb(realDev('constructor')), halves: {} }), target).label, 'Connected, half not named');
  assert.equal(vialStatus(conn({ usb: usb(realDev()), halves: { [SERIAL]: 'middle' } }), target).label, 'Connected, half not named');

  // two plugged in at once: shown, but no naming until it is clear which one is meant
  s = vialStatus(conn({ usb: usb(realDev(), realDev('E46064D700000000')), halves: { [SERIAL]: 'left' } }), target);
  assert.deepEqual([s.label, s.glyph, s.actions], ['Left half connected', { left: 'on', right: 'maybe' }, []]);
});

test('ZMK keyboard: which half is on USB', () => {
  let s = zmkStatus(conn(), NAME);
  assert.deepEqual([s.label, s.tone, s.glyph], ['Not connected by USB', 'off', { left: 'off', right: 'off' }]);

  s = zmkStatus(conn({ usb: usb(zmkDev('Corne Choc Pro')) }), NAME);
  assert.deepEqual([s.label, s.tone, s.glyph], ['Left half connected', 'ok', { left: 'on', right: 'off' }]);

  s = zmkStatus(conn({ usb: usb(zmkDev('')) }), NAME);
  assert.deepEqual([s.label, s.glyph], ['Right half connected', { left: 'off', right: 'on' }]);

  s = zmkStatus(conn({ usb: usb(zmkDev('Corne Choc Pro'), zmkDev('')) }), NAME);
  assert.deepEqual([s.label, s.glyph], ['Both halves connected', { left: 'on', right: 'on' }]);

  // another ZMK keyboard's left half is not this keyboard
  s = zmkStatus(conn({ usb: usb(zmkDev('Sofle Choc Pro')) }), NAME);
  assert.equal(s.label, 'Not connected by USB');
  assert.ok(s.lines.some((l) => /Sofle Choc Pro/.test(l.text)));

  // a keyboard that is not ZMK at all is ignored
  s = zmkStatus(conn({ usb: usb({ vendorId: 1452, productId: 591, product: 'Keychron K3', vendor: 'Keychron' }, vialDev()) }), NAME);
  assert.equal(s.label, 'Not connected by USB');
});

test('ZMK keyboard: which half is in bootloader mode', () => {
  let s = zmkStatus(conn({ volumes: [drive(facts('left', 'Corne Choc Pro'))] }), NAME);
  assert.deepEqual([s.label, s.tone, s.glyph], ['Left half in bootloader mode', 'boot', { left: 'boot', right: 'off' }]);

  s = zmkStatus(conn({ volumes: [drive(facts('right', ''))] }), NAME);
  assert.deepEqual([s.label, s.glyph], ['Right half in bootloader mode', { left: 'off', right: 'boot' }]);

  // still reading the drive, or the drive would not say: a half is there, the side is open
  s = zmkStatus(conn({ volumes: [drive({ pending: true })] }), NAME);
  assert.deepEqual([s.label, s.glyph], ['A half in bootloader mode', { left: 'maybe', right: 'maybe' }]);
  s = zmkStatus(conn({ volumes: [drive(null)] }), NAME);
  assert.deepEqual([s.label, s.glyph], ['A half in bootloader mode', { left: 'maybe', right: 'maybe' }]);

  // one half running, the other in bootloader mode
  s = zmkStatus(conn({ usb: usb(zmkDev('Corne Choc Pro')), volumes: [drive(facts('right', ''))] }), NAME);
  assert.deepEqual([s.label, s.glyph], ['Left half connected, right half in bootloader mode', { left: 'on', right: 'boot' }]);

  // the left half of another keyboard is called out and never counted as this keyboard's
  s = zmkStatus(conn({ volumes: [drive(facts('left', 'Sofle Choc Pro'))] }), NAME);
  assert.deepEqual([s.tone, s.glyph], ['warn', { left: 'off', right: 'off' }]);
  assert.equal(driveInfo(drive(facts('left', 'Sofle Choc Pro')), NAME).other, 'Sofle Choc Pro');
  assert.equal(driveInfo(drive(facts('left', 'SETTINGS RESET', { role: null, reset: true })), NAME).other, null);

  // the wired keyboard's bootloader drive is not a ZMK half
  s = zmkStatus(conn({ volumes: [drive(null, 'RP2040')] }), NAME);
  assert.equal(s.label, 'Not connected by USB');
});

test('ZMK keyboard: an old or stopped server is said plainly', () => {
  assert.equal(zmkStatus(conn({ server: 'old', usb: { supported: false, devices: [] } }), NAME).label, 'Restart the app');
  assert.equal(zmkStatus(conn({ server: 'down', usb: { supported: false, devices: [] } }), NAME).label, 'Server not running');
  assert.equal(zmkStatus({ server: 'unknown', usb: { supported: false, devices: [] }, volumes: [], hid: { supported: false, devices: [] } }, NAME).label, 'Looking…');
  // an old server still reports drives, without the half
  const s = zmkStatus(conn({ server: 'old', usb: { supported: false, devices: [] }, volumes: [{ path: '/Volumes/BOOT', name: 'BOOT', chip: 'nRF52840' }] }), NAME);
  assert.equal(s.label, 'A half in bootloader mode');
  assert.ok(s.lines.some((l) => /npm start/.test(l.text)));
});

test('Vial keyboard: connected, and which half once the mark was read', () => {
  const hid = (...devices) => ({ supported: true, devices });
  const h = (o) => ({ vendorId: 0xFEED, productId: 4, product: 'Corne MX Pro', checked: false, side: null, error: null, ...o });

  let s = vialStatus(conn(), target);
  assert.deepEqual([s.label, s.tone, s.glyph, s.actions], ['Not connected', 'off', { left: 'off', right: 'off' }, []]);

  // seen on USB, the browser has not been allowed to talk to it yet
  s = vialStatus(conn({ usb: usb(vialDev()) }), target);
  assert.deepEqual([s.label, s.tone, s.glyph, s.actions], ['Connected, half not checked', 'maybe', { left: 'maybe', right: 'maybe' }, ['check']]);

  // read, and there is no mark on this half yet
  s = vialStatus(conn({ usb: usb(vialDev()), hid: hid(h({ checked: true })) }), target);
  assert.deepEqual([s.label, s.glyph, s.actions, s.marked], ['Connected, half not marked', { left: 'maybe', right: 'maybe' }, ['mark'], null]);

  s = vialStatus(conn({ usb: usb(vialDev()), hid: hid(h({ checked: true, side: 'left' })) }), target);
  assert.deepEqual([s.label, s.tone, s.glyph, s.marked], ['Left half connected', 'ok', { left: 'on', right: 'off' }, 'left']);

  // without the server's USB list (not macOS) the browser alone is enough
  s = vialStatus(conn({ usb: { supported: false, devices: [] }, hid: hid(h({ checked: true, side: 'right' })) }), target);
  assert.deepEqual([s.label, s.glyph], ['Right half connected', { left: 'off', right: 'on' }]);

  // the keyboard would not talk (for one, an unlock that was never finished): say why, offer to look again
  s = vialStatus(conn({ usb: usb(vialDev()), hid: hid(h({ checked: true, error: 'The keyboard is still waiting for an unlock' })) }), target);
  assert.deepEqual([s.label, s.tone, s.actions], ['Connected, half not read', 'warn', ['check']]);
  assert.ok(s.lines.some((l) => /unlock/.test(l.text)));

  // the 5-column Mini shares the Vial id; it is told apart by its USB product id and not offered anything
  s = vialStatus(conn({ usb: usb(vialDev(0x0104)) }), target);
  assert.deepEqual([s.label, s.tone, s.actions], ['Mini connected', 'warn', []]);

  // its bootloader drive cannot say which half it is
  s = vialStatus(conn({ volumes: [drive(null, 'RP2040')] }), target);
  assert.deepEqual([s.label, s.tone, s.glyph], ['A half in bootloader mode', 'boot', { left: 'maybe', right: 'maybe' }]);

  // the wireless keyboard is never taken for the wired one
  s = vialStatus(conn({ usb: usb(zmkDev('Corne Choc Pro'), zmkDev('')) }), target);
  assert.equal(s.label, 'Not connected');
});
