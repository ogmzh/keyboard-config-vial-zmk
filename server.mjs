#!/usr/bin/env node
// Keymap Bridge local server. No dependencies: `node server.mjs`, then open http://localhost:4777
//
// It serves the editor and does the things a browser cannot: read and write the keymap in your
// zmk-config folder, run git, fetch firmware builds with the GitHub CLI, and copy a UF2 file onto
// a keyboard that is in bootloader mode. It listens on this computer only.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseIoreg, uf2Payload, uf2Problem, firmwareFacts } from './lib/usb.mjs';
import { sameKeyboard } from './public/js/core/connection.js';

const APP = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(APP, 'public');
const SETTINGS = path.join(APP, 'settings.json');
const PORT = Number(process.env.PORT || 4777);
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.keymap': 'text/plain; charset=utf-8', '.ico': 'image/x-icon' };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// ---------- settings ----------
async function readSettings() { try { return JSON.parse(await fsp.readFile(SETTINGS, 'utf8')); } catch { return {}; } }
async function writeSettings(patch) { const s = { ...(await readSettings()), ...patch }; await fsp.writeFile(SETTINGS, JSON.stringify(s, null, 2) + '\n'); return s; }
const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

async function repoPath() {
  const s = await readSettings();
  if (!s.repoPath) throw new HttpError(409, 'No zmk-config folder is set yet.');
  return s.repoPath;
}

// A path inside the repo, refusing anything that escapes it.
function inside(base, rel) {
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) throw new HttpError(400, 'That path is outside the folder.');
  return full;
}

// ---------- running tools ----------
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: opts.timeout || 120000, cwd: opts.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: !!err && err.code === 'ENOENT' });
    });
  });
}
const git = (cwd, ...args) => run('git', args, { cwd });
async function need(result, what) {
  if (result.missing) throw new HttpError(500, `${what} is not installed on this computer.`);
  if (!result.ok) throw new HttpError(500, (result.stderr || result.stdout || `${what} failed`).trim());
  return result.stdout;
}
const hasTool = async (cmd) => !(await run(cmd, ['--version'])).missing;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => fsp.access(p).then(() => true, () => false);

// ---------- repo ----------
async function listKeymaps(base) {
  const out = [];
  const dir = path.join(base, 'config');
  let names = [];
  try { names = await fsp.readdir(dir); } catch { /* no config folder */ }
  for (const n of names.filter((x) => x.endsWith('.keymap')).sort()) {
    const id = n.replace(/\.keymap$/, '');
    let layoutFile = null;
    for (const cand of [`config/${id}.json`, 'config/info.json']) { try { await fsp.access(path.join(base, cand)); layoutFile = cand; break; } catch { /* next */ } }
    out.push({ id, file: `config/${n}`, layoutFile });
  }
  return out;
}

async function gitStatus(base) {
  const isRepo = await git(base, 'rev-parse', '--is-inside-work-tree');
  if (isRepo.missing) return { git: false, reason: 'git is not installed' };
  if (!isRepo.ok) return { git: false, reason: 'This folder is not a git repository' };
  const [branch, status, last, remote] = await Promise.all([
    git(base, 'rev-parse', '--abbrev-ref', 'HEAD'),
    git(base, 'status', '--porcelain=v1', '--branch'),
    git(base, 'log', '-1', '--format=%h%x09%s%x09%cr%x09%H'),
    git(base, 'remote', 'get-url', 'origin'),
  ]);
  const lines = status.stdout.split('\n').filter(Boolean);
  const head = lines[0] || '';
  const ahead = Number((/ahead (\d+)/.exec(head) || [])[1] || 0);
  const behind = Number((/behind (\d+)/.exec(head) || [])[1] || 0);
  const [hash, subject, when, full] = last.stdout.trim().split('\t');
  const url = remote.ok ? remote.stdout.trim() : '';
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
  return {
    git: true, branch: branch.stdout.trim(), ahead, behind,
    changed: lines.slice(1).map((l) => ({ code: l.slice(0, 2), file: l.slice(3) })),
    last: hash ? { hash, subject, when, full } : null,
    remote: url, github: m ? { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}` } : null,
  };
}

// ---------- UF2 and bootloader drives ----------
const UF2_FAMILIES = { 0xADA52840: 'nRF52840', 0xE48BFF56: 'RP2040', 0xE48BFF59: 'RP2350', 0x1B57745F: 'nRF52833' };
async function uf2Info(file) {
  const fd = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(32);
    await fd.read(buf, 0, 32, 0);
    if (buf.readUInt32LE(0) !== 0x0A324655 || buf.readUInt32LE(4) !== 0x9E5D5157) return { valid: false };
    const flags = buf.readUInt32LE(8); const fam = buf.readUInt32LE(28);
    return { valid: true, family: flags & 0x2000 ? (UF2_FAMILIES[fam] || '0x' + fam.toString(16)) : null, blocks: buf.readUInt32LE(24) };
  } finally { await fd.close(); }
}

async function bootVolumes() {
  const roots = process.platform === 'darwin' ? ['/Volumes'] : process.platform === 'linux' ? [`/media/${os.userInfo().username}`, `/run/media/${os.userInfo().username}`, '/media'] : [];
  const out = [];
  for (const root of roots) {
    let names = [];
    try { names = await fsp.readdir(root); } catch { continue; }
    for (const n of names) {
      const dir = path.join(root, n);
      try {
        const info = await fsp.readFile(path.join(dir, 'INFO_UF2.TXT'), 'utf8');
        const field = (k) => ((new RegExp(`^${k}:\\s*(.+)$`, 'mi').exec(info) || [])[1] || '').trim();
        const model = field('Model'); const board = field('Board-ID');
        const chip = /RP2|RPI/i.test(model + board) ? 'RP2040' : /nRF52/i.test(info) ? 'nRF52840' : null;
        out.push({ path: dir, name: n, model, board, chip });
      } catch { /* not a bootloader drive */ }
    }
  }
  if (process.platform === 'win32') {
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const dir = `${letter}:\\`;
      try { const info = await fsp.readFile(path.join(dir, 'INFO_UF2.TXT'), 'utf8'); out.push({ path: dir, name: dir, model: ((/^Model:\s*(.+)$/mi.exec(info) || [])[1] || '').trim(), board: '', chip: /RP2/i.test(info) ? 'RP2040' : /nRF52/i.test(info) ? 'nRF52840' : null }); } catch { /* skip */ }
    }
  }
  return out;
}

// ---------- which half is which ----------
const nameSide = (name) => (/right/i.test(name) ? 'right' : /left/i.test(name) ? 'left' : null);

// What a firmware file in the "firmware" folder is, read from its contents (kept until the file changes).
const fileFactsCache = new Map(); // path -> { key, facts }
async function fileFacts(full, st, info) {
  if (!info.valid || !info.family || !info.family.startsWith('nRF52') || st.size > 16 * 1024 * 1024) return null;
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = fileFactsCache.get(full);
  if (hit && hit.key === key) return hit.facts;
  const facts = await fsp.readFile(full).then((b) => firmwareFacts(uf2Payload(b)), () => null);
  fileFactsCache.set(full, { key, facts });
  return facts;
}

// A nRF52 bootloader drive offers the firmware that is installed right now as CURRENT.UF2. Reading it tells
// which half is on the drive. That takes a couple of seconds over USB, so it runs in the background and the
// answer is kept for a few seconds. Flashing never trusts the kept answer: it reads again first.
const driveFacts = new Map(); // drive path -> { id, at, facts, reading }
const FACTS_TTL = 8000;
const FACTS_KEEP = 30000;
let flashing = false;
async function readDriveFacts(vol) {
  const file = path.join(vol.path, 'CURRENT.UF2');
  const read = (async () => {
    const st = await fsp.stat(file);
    if (st.size > 16 * 1024 * 1024) return null;
    return firmwareFacts(uf2Payload(await fsp.readFile(file, { signal: AbortSignal.timeout(20000) })));
  })();
  read.catch(() => {}); // a read that loses the race below must not count as an unhandled error
  return Promise.race([read, sleep(21000).then(() => null)]);
}
async function factsFor(vol, { fresh = false } = {}) {
  if (!vol.chip || !vol.chip.startsWith('nRF52')) return null;
  let id; try { id = String((await fsp.stat(vol.path)).dev); } catch { return null; }
  let entry = driveFacts.get(vol.path);
  if (!entry || entry.id !== id) { entry = { id, at: 0, facts: undefined, reading: null }; driveFacts.set(vol.path, entry); }
  const current = entry.facts !== undefined && Date.now() - entry.at < FACTS_TTL;
  if (!fresh && (current || flashing)) return entry.facts ?? null;
  if (!entry.reading) {
    const mine = entry;
    mine.reading = readDriveFacts(vol).catch(() => null).then((f) => { mine.facts = f; mine.at = Date.now(); mine.reading = null; return f; });
  }
  if (fresh) return entry.reading;
  // an answer that is a little old is shown while the new one is read; an old one is not
  return entry.facts !== undefined && Date.now() - entry.at < FACTS_KEEP ? entry.facts : { pending: true };
}

async function usbDevices() {
  if (process.platform !== 'darwin') return { supported: false, devices: [] };
  const r = await run('/usr/sbin/ioreg', ['-p', 'IOUSB', '-l', '-w0'], { timeout: 5000 });
  return r.ok ? { supported: true, devices: parseIoreg(r.stdout) } : { supported: false, devices: [] };
}

// Copies one firmware file to one bootloader drive, after every check. Called by 'POST /api/flash' only.
async function flashNow(body) {
  const src = inside(path.join(APP, 'firmware'), String(body.file || ''));
  const vols = await bootVolumes();
  const vol = vols.find((v) => v.path === body.volume);
  if (!vol) throw new HttpError(409, 'That keyboard is no longer in bootloader mode. Double-tap its reset button and try again.');
  const info = await uf2Info(src);
  if (!info.valid) throw new HttpError(400, 'That file is not UF2 firmware.');
  if (info.family && vol.chip && info.family !== vol.chip && !(info.family.startsWith('nRF52') && vol.chip.startsWith('nRF52'))) {
    throw new HttpError(409, `This firmware is for a ${info.family} keyboard, but the drive "${vol.name}" is a ${vol.chip} keyboard. Nothing was copied.`);
  }
  const name = path.basename(src);
  // Firmware for another keyboard with the same chip would pass the check above, so the file name has to
  // carry this keyboard's board name (as the files from the GitHub build do).
  const board = String(body.board || '').toLowerCase();
  if (board && !name.toLowerCase().includes(board)) throw new HttpError(409, `"${name}" does not look like firmware for this keyboard (${board}). Nothing was copied.`);
  const data = await fsp.readFile(src);
  const problem = uf2Problem(data);
  if (problem) throw new HttpError(400, `"${name}" is damaged or incomplete: ${problem}. Download it again. Nothing was copied.`);
  // Left file onto the right half, or the other way round? Ask the drive what it is running, now.
  const isNrf = !!(info.family && info.family.startsWith('nRF52'));
  const file = isNrf ? firmwareFacts(uf2Payload(data)) : null;
  const fileSide = (file && file.side) || nameSide(name);
  const isReset = /settings.?reset/i.test(name) || !!(file && file.reset);
  if (isReset && body.reset !== true) throw new HttpError(409, `"${name}" is the settings reset: it erases everything the half has stored, Bluetooth pairings included. Nothing was copied.`);
  const drive = await factsFor(vol, { fresh: true });
  // "force" is sent only after the person was shown the mismatch and chose to go on (repairing a wrong flash)
  if (body.force !== true && drive && drive.zmk) {
    if (drive.side && fileSide && drive.side !== fileSide) {
      throw new HttpError(409, `The half on "${vol.name}" is running ${drive.side}-half firmware, and this file is for the ${fileSide} half. Nothing was copied.`);
    }
    const keyboard = String(body.keyboard || '');
    if (keyboard && drive.product && !/settings.?reset/i.test(drive.product) && !sameKeyboard(drive.product, keyboard)) {
      throw new HttpError(409, `The half on "${vol.name}" is running firmware for another keyboard (${drive.product}). Nothing was copied.`);
    }
  }
  // To tell afterwards whether the half came back as a keyboard: the ZMK keyboards that are on USB now.
  const zmkOnUsb = (list) => list.devices.filter((d) => (d.vendorId === 0x1D50 && d.productId === 0x615E) || d.vendor === 'ZMK Project');
  const before = isNrf ? await usbDevices() : { supported: false, devices: [] };
  let copyError = null;
  try {
    await fsp.writeFile(path.join(vol.path, name), data);
  } catch (e) {
    // The drive vanishes the moment the keyboard accepts the firmware; that shows up as an I/O error here.
    // A cable pulled half-way looks exactly the same, so this alone is not proof that the firmware arrived.
    if (!['EIO', 'ENOENT', 'ENXIO', 'EBADF', 'ENODEV', 'EINVAL'].includes(e.code)) throw new HttpError(500, `Copy failed: ${e.message}`);
    copyError = e.code;
  } finally { driveFacts.delete(vol.path); }
  // A keyboard that took the firmware restarts and its drive goes away. A drive that stays means it did not.
  let restarted = false;
  for (let i = 0; i < 24 && !restarted; i++) { await sleep(250); restarted = !(await exists(path.join(vol.path, 'INFO_UF2.TXT'))); }
  // The real proof: the half shows up on USB again, running. Only macOS can list that; null means "cannot tell".
  let running = null;
  if (restarted && before.supported) {
    const had = new Set(zmkOnUsb(before).map((d) => d.location));
    running = false;
    for (let i = 0; i < 16 && !running; i++) { await sleep(500); running = zmkOnUsb(await usbDevices()).some((d) => !had.has(d.location)); }
  }
  return { ok: true, copied: name, bytes: data.length, volume: vol.name, restarted, running, copyError, reset: isReset, driveSide: drive ? drive.side : null, fileSide };
}

async function listFirmware() {
  const base = path.join(APP, 'firmware');
  const out = [];
  const walk = async (dir, depth) => {
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.uf2')) {
        const st = await fsp.stat(full);
        const info = await uf2Info(full).catch(() => ({ valid: false }));
        const facts = await fileFacts(full, st, info);
        const byName = nameSide(e.name);
        const inside = facts ? facts.side : null;
        out.push({
          file: path.relative(base, full), name: e.name, size: st.size, modified: st.mtimeMs,
          // what the file contains wins over what it is called; a disagreement is flagged and not flashed
          side: inside || byName, sideConflict: !!(inside && byName && inside !== byName),
          reset: /settings_reset/i.test(e.name) || !!(facts && facts.reset), product: facts ? facts.product : null, ...info,
        });
      }
    }
  };
  await walk(base, 0);
  return out.sort((a, b) => b.modified - a.modified);
}

// ---------- API ----------
const routes = {
  'GET /api/state': async () => {
    const s = await readSettings();
    const tools = { git: await hasTool('git'), gh: await hasTool('gh') };
    let repo = null;
    if (s.repoPath) {
      try { await fsp.access(s.repoPath); repo = { path: s.repoPath, keymaps: await listKeymaps(s.repoPath), status: await gitStatus(s.repoPath) }; }
      catch { repo = { path: s.repoPath, missing: true, keymaps: [] }; }
    }
    return { app: 'keymap-bridge', version: 1, platform: process.platform, appDir: APP, tools, repo, lastKeymap: s.lastKeymap || null };
  },

  'POST /api/config': async (body) => {
    const p = path.resolve(expandHome(String(body.repoPath || '').trim()));
    let st; try { st = await fsp.stat(p); } catch { throw new HttpError(400, `There is no folder at ${p}`); }
    if (!st.isDirectory()) throw new HttpError(400, `${p} is not a folder`);
    const keymaps = await listKeymaps(p);
    if (!keymaps.length) throw new HttpError(400, `No .keymap file found in ${path.join(p, 'config')}. Pick the top folder of your zmk-config.`);
    await writeSettings({ repoPath: p });
    return { ok: true, path: p, keymaps };
  },

  'POST /api/clone': async (body) => {
    const url = String(body.url || '').trim();
    if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(url)) throw new HttpError(400, 'That does not look like a git URL.');
    const name = url.replace(/\.git$/, '').split(/[/:]/).pop().replace(/[^\w.-]/g, '') || 'zmk-config';
    const dest = path.join(APP, 'repos', name);
    try { await fsp.access(dest); throw new HttpError(409, `${dest} already exists. Use that folder, or remove it first.`); } catch (e) { if (e instanceof HttpError) throw e; }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await need(await run('git', ['clone', url, dest], { timeout: 300000 }), 'git');
    await writeSettings({ repoPath: dest });
    return { ok: true, path: dest, keymaps: await listKeymaps(dest) };
  },

  'GET /api/keymap': async (_b, q) => {
    const base = await repoPath();
    const file = q.get('file') || '';
    if (!file.endsWith('.keymap')) throw new HttpError(400, 'Not a keymap file.');
    const text = await fsp.readFile(inside(base, file), 'utf8');
    const id = path.basename(file, '.keymap');
    let layout = null; let sidecar = null;
    for (const cand of [`config/${id}.json`, 'config/info.json']) { try { layout = JSON.parse(await fsp.readFile(inside(base, cand), 'utf8')); break; } catch { /* next */ } }
    try { sidecar = JSON.parse(await fsp.readFile(inside(base, `config/${id}.vial.json`), 'utf8')); } catch { /* none yet */ }
    await writeSettings({ lastKeymap: file });
    return { file, text, layout, sidecar };
  },

  'PUT /api/keymap': async (body) => {
    const base = await repoPath();
    const file = String(body.file || '');
    if (!file.endsWith('.keymap')) throw new HttpError(400, 'Not a keymap file.');
    const written = [];
    const save = async (rel, text) => {
      const full = inside(base, rel);
      const tmp = full + '.tmp-' + process.pid;
      await fsp.writeFile(tmp, text);
      await fsp.rename(tmp, full);
      written.push(rel);
    };
    if (typeof body.text === 'string') {
      if (body.expect !== undefined) {
        const current = await fsp.readFile(inside(base, file), 'utf8').catch(() => null);
        if (current !== null && current !== body.expect) throw new HttpError(409, 'The file changed on disk since it was opened. Reload it before saving.');
      }
      await save(file, body.text);
    }
    if (body.sidecar !== undefined) await save(`config/${path.basename(file, '.keymap')}.vial.json`, JSON.stringify(body.sidecar, null, 2) + '\n');
    return { ok: true, written, status: await gitStatus(base) };
  },

  'GET /api/git/status': async () => gitStatus(await repoPath()),

  'GET /api/git/diff': async (_b, q) => {
    const base = await repoPath();
    const file = q.get('file') || '';
    inside(base, file);
    return { diff: (await git(base, 'diff', '--no-color', '--', file)).stdout };
  },

  'POST /api/git/commit': async (body) => {
    const base = await repoPath();
    const files = (body.files || []).map(String);
    if (!files.length) throw new HttpError(400, 'Nothing to commit.');
    files.forEach((f) => inside(base, f));
    const message = String(body.message || '').trim() || 'Update keymap';
    await need(await git(base, 'add', '--', ...files), 'git');
    const staged = await git(base, 'diff', '--cached', '--quiet', '--', ...files);
    if (staged.ok) return { ok: true, nothing: true, status: await gitStatus(base) };
    await need(await git(base, 'commit', '-m', message, '--', ...files), 'git');
    return { ok: true, status: await gitStatus(base) };
  },

  'POST /api/git/push': async () => { const base = await repoPath(); const r = await git(base, 'push'); await need(r, 'git'); return { ok: true, output: (r.stderr + r.stdout).trim(), status: await gitStatus(base) }; },
  'POST /api/git/pull': async () => { const base = await repoPath(); const r = await git(base, 'pull', '--ff-only'); await need(r, 'git'); return { ok: true, output: (r.stderr + r.stdout).trim(), status: await gitStatus(base) }; },

  'GET /api/builds': async () => {
    const base = await repoPath();
    const r = await run('gh', ['run', 'list', '--limit', '8', '--json', 'databaseId,status,conclusion,headSha,displayTitle,createdAt,url,workflowName,headBranch'], { cwd: base });
    if (r.missing) return { available: false, reason: 'The GitHub CLI (gh) is not installed. Install it with "brew install gh" and run "gh auth login", or download the firmware from the Actions page.' };
    if (!r.ok) return { available: false, reason: r.stderr.trim() || 'gh could not list the builds.' };
    return { available: true, runs: JSON.parse(r.stdout || '[]') };
  },

  'POST /api/builds/download': async (body) => {
    const base = await repoPath();
    const id = String(body.runId || '');
    if (!/^\d+$/.test(id)) throw new HttpError(400, 'Bad run id.');
    const dest = path.join(APP, 'firmware', id);
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(dest, { recursive: true });
    await need(await run('gh', ['run', 'download', id, '--dir', dest], { cwd: base, timeout: 300000 }), 'GitHub CLI (gh)');
    return { ok: true, firmware: await listFirmware() };
  },

  'GET /api/firmware': async () => ({ dir: path.join(APP, 'firmware'), files: await listFirmware() }),
  'GET /api/volumes': async () => ({ volumes: await bootVolumes() }),

  // Everything the indicator needs in one call: USB devices, bootloader drives, and which half is on each drive.
  'GET /api/connection': async () => {
    const [usb, vols] = await Promise.all([usbDevices(), bootVolumes()]);
    for (const p of [...driveFacts.keys()]) if (!vols.some((v) => v.path === p)) driveFacts.delete(p);
    const volumes = [];
    for (const v of vols) volumes.push({ ...v, firmware: await factsFor(v) });
    return { usb, volumes, halves: (await readSettings()).halves || {} };
  },

  // Remembers which half has which USB serial number (side null forgets it).
  // Only the app's settings file changes; nothing is sent to the keyboard.
  'POST /api/half': async (body) => {
    const serial = String(body.serial || '');
    if (!/^[A-Za-z0-9:.-]{4,64}$/.test(serial)) throw new HttpError(400, 'That is not a serial number.');
    if (body.side != null && body.side !== 'left' && body.side !== 'right') throw new HttpError(400, 'A half is left or right.');
    const usb = await usbDevices();
    if (!usb.devices.some((d) => d.serial === serial)) throw new HttpError(409, 'That keyboard is not plugged in any more.');
    const halves = { ...((await readSettings()).halves || {}) };
    if (body.side) halves[serial] = body.side; else delete halves[serial];
    await writeSettings({ halves });
    return { halves };
  },

  'POST /api/flash': async (body) => {
    // Taken before anything is awaited, so that two requests can never both get past this line.
    if (flashing) throw new HttpError(409, 'Another firmware file is being copied right now. Wait for it to finish.');
    flashing = true;
    try { return await flashNow(body); } finally { flashing = false; }
  },

  'POST /api/exports': async (body) => {
    const name = String(body.name || '').replace(/[^\w.@ -]/g, '_');
    if (!name) throw new HttpError(400, 'Missing file name.');
    const dir = path.join(APP, 'exports');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, name), String(body.text ?? ''));
    return { ok: true, path: path.join(dir, name) };
  },
};

// ---------- http ----------
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 8 * 1024 * 1024) throw new HttpError(413, 'Too large.'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Bad JSON.'); }
}

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body); };
  try {
    // Only this computer may talk to the server, and only from the app's own pages.
    if (!HOSTS.has(req.headers.host || '')) throw new HttpError(403, 'Forbidden');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, 'Not found');
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && !HOSTS.has(origin.replace(/^https?:\/\//, ''))) throw new HttpError(403, 'Forbidden');
        if (req.headers['x-keymap-bridge'] !== '1' || !/^application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(403, 'Forbidden');
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      return send(200, JSON.stringify(await handler(body, url.searchParams)));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    let file;
    if (rel.startsWith('/bundled/')) file = inside(path.join(APP, 'keymaps', 'bundled'), rel.slice('/bundled/'.length));
    else file = inside(PUBLIC, '.' + rel);
    const data = await fsp.readFile(file).catch(() => { throw new HttpError(404, 'Not found'); });
    send(200, data, MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    send(status, JSON.stringify({ error: e.message || 'Something went wrong.' }));
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Keymap Bridge may already be running: open http://localhost:${PORT}\nOr start it on another port: PORT=4788 node server.mjs`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Keymap Bridge is running at ${url}\nPress Ctrl+C to stop.`);
  if (!process.argv.includes('--no-open') && !process.env.NO_OPEN) {
    const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* the address is printed above */ }
  }
});
