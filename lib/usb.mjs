// What the server can tell about plugged-in keyboards: the USB device list (macOS), and which half a
// ZMK firmware image is for. Plain functions with no side effects, so the tests run them without a keyboard.

// Reads the output of `ioreg -p IOUSB -l -w0`: one "+-o Name@location <class …>" line per device,
// followed by its properties.
export function parseIoreg(text) {
  const nodes = []; let cur = null;
  for (const line of String(text).split('\n')) {
    const node = /\+-o (.*?)\s+<class /.exec(line);
    if (node) { cur = { node: node[1], props: {} }; nodes.push(cur); continue; }
    const prop = /^[\s|]*"([^"]+)" = (.*)$/.exec(line);
    if (cur && prop) cur.props[prop[1]] = prop[2];
  }
  const str = (v) => { const m = /^"(.*)"$/.exec(v || ''); return m ? m[1].trim() : ''; };
  const num = (v) => (/^\d+$/.test(v || '') ? Number(v) : null);
  return nodes.filter((n) => num(n.props.idVendor) !== null).map((n) => ({
    vendorId: num(n.props.idVendor),
    productId: num(n.props.idProduct),
    product: str(n.props['USB Product Name']) || str(n.props.kUSBProductString),
    vendor: str(n.props['USB Vendor Name']) || str(n.props.kUSBVendorString),
    serial: str(n.props['USB Serial Number']) || str(n.props.kUSBSerialNumberString),
    location: num(n.props.locationID),
  }));
}

// Where an application may be written, per chip family: [first address, end). Everything else on the chip
// (the bootloader, its settings, the part that starts it) is out of bounds for a firmware file.
const UF2_AREA = { 0xADA52840: [0x1000, 0xF4000], 0xE48BFF56: [0x10000000, 0x11000000] };

// Checks every block of a UF2 file. Returns null when the file is whole and sound, or a few words saying
// what is wrong with it. A file cut short by a failed download, or glued together from two files, would
// otherwise be copied to the keyboard as it is and leave that half without working firmware.
export function uf2Problem(buf) {
  if (!buf.length || buf.length % 512) return 'its size is not a whole number of 512-byte blocks, so part of it is missing';
  const total = buf.length / 512;
  let family = null;
  for (let i = 0; i < total; i++) {
    const o = i * 512;
    if (buf.readUInt32LE(o) !== 0x0A324655 || buf.readUInt32LE(o + 4) !== 0x9E5D5157 || buf.readUInt32LE(o + 508) !== 0x0AB16F30) return `block ${i + 1} of ${total} is not a UF2 block`;
    const flags = buf.readUInt32LE(o + 8); const addr = buf.readUInt32LE(o + 12); const size = buf.readUInt32LE(o + 16);
    if (flags & 0x1) return `block ${i + 1} is marked as not being firmware`;
    if (!size || size > 476) return `block ${i + 1} has an impossible size`;
    if (buf.readUInt32LE(o + 20) !== i || buf.readUInt32LE(o + 24) !== total) return `block ${i + 1} is out of order or blocks are missing (the file says it has ${buf.readUInt32LE(o + 24)} blocks and holds ${total})`;
    const fam = flags & 0x2000 ? buf.readUInt32LE(o + 28) : null;
    if (i === 0) family = fam;
    else if (fam !== family) return `block ${i + 1} is for a different kind of chip than the first block`;
    const area = UF2_AREA[family];
    if (area && (addr < area[0] || addr + size > area[1])) return `block ${i + 1} would be written outside the application area (address 0x${addr.toString(16)})`;
  }
  return null;
}

// The firmware bytes inside a UF2 file, joined in file order (512-byte blocks, up to 476 payload bytes each).
export function uf2Payload(buf) {
  const parts = [];
  for (let off = 0; off + 512 <= buf.length; off += 512) {
    if (buf.readUInt32LE(off) !== 0x0A324655 || buf.readUInt32LE(off + 4) !== 0x9E5D5157) continue;
    parts.push(buf.subarray(off + 32, off + 32 + Math.min(buf.readUInt32LE(off + 16), 476)));
  }
  return Buffer.concat(parts);
}

// The USB product name a ZMK image announces. Its USB text table holds [length, 3, characters, room to
// widen them] for the maker "ZMK Project", then the same for the product. The central half carries the
// keyboard's name there; the other half's is empty. Returns null when the table is not found.
function zmkProduct(image) {
  const at = image.indexOf(Buffer.from('\x18\x03ZMK Project', 'latin1'));
  if (at === -1) return null;
  const next = at + image[at];
  if (next + 2 > image.length || image[next + 1] !== 0x03) return null;
  const chars = (image[next] - 2) / 2;
  if (!Number.isInteger(chars) || chars < 0 || chars > 60) return null;
  const s = image.toString('latin1', next + 2, next + 2 + chars);
  return /^[\x20-\x7E]*$/.test(s) ? s.trim() : null;
}

// What a ZMK firmware image (the payload of a .uf2, or of a bootloader drive's CURRENT.UF2) says about itself.
// The central half of a split keeps the list of its peripherals; the peripheral half runs the split service.
// On Keebart's boards, as in ZMK generally, the central half is the left one.
export function firmwareFacts(image) {
  const has = (s) => image.includes(s);
  const role = has('ble/peripheral_addresses') ? 'central' : has('Split Peripheral Notification Queue') ? 'peripheral' : null;
  // settings_reset builds have no split code; the board's own part names can still tell the halves apart
  const hint = has('encoder_left_') && !has('encoder_right_') ? 'left' : has('encoder_right_') && !has('encoder_left_') ? 'right' : null;
  const zmk = role !== null || has('ZMK Project');
  return {
    zmk,
    role,
    side: !zmk ? null : role === 'central' ? 'left' : role === 'peripheral' ? 'right' : hint,
    reset: zmk && has('settings_reset'),
    product: zmk ? zmkProduct(image) : null,
  };
}
