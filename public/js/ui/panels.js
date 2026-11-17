// The right-hand panel. For the ZMK board: save, send to GitHub, fetch firmware, flash.
// For the Vial board: what carries over, options, .vil export and writing over USB.

import { h, modal, code, toast, download, confirmDialog, field } from './dom.js';
import { api } from '../app.js';
import { keyboardView } from './keyboard.js';
import { buildVil, vilToText } from '../core/vil.js';
import { VialKeyboard, WebHidTransport, sideOf } from '../core/vial-hid.js';
import { driveInfo, vialStatus } from '../core/connection.js';
import { connectionDetail, live } from './connection.js';

const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const baseName = (app) => app.source.file.split('/').pop().replace(/\.keymap$/, '');
const block = (title, ...children) => h('section', { class: 'block' }, title ? h('h3', null, title) : null, children);

// ---------- choosing where the keymap comes from ----------
export function sourceDialog(app) {
  const s = app.server;
  const repo = s && s.repo;
  const pathInput = h('input', { type: 'text', class: 'tok', placeholder: '~/Projects/zmk-config', value: repo ? repo.path : '', spellcheck: false });
  const urlInput = h('input', { type: 'text', class: 'tok', value: 'https://github.com/ogmzh/zmk-config', spellcheck: false });
  const msg = h('p', { class: 'muted' });
  const busy = (t) => { msg.textContent = t; };
  const guarded = async (fn) => {
    if (app.dirty && !(await confirmDialog('Discard unsaved changes?', 'Discard', { danger: true, detail: 'Opening another keymap drops the edits you have not saved.' }))) return;
    try { await fn(); m.close(); } catch (e) { busy(''); toast(e.message, 'error'); }
  };
  const useFolder = () => guarded(async () => {
    busy('Looking in that folder…');
    const r = await api('POST', '/api/config', { repoPath: pathInput.value });
    await app.refreshServer();
    const km = r.keymaps.find((k) => /corne/.test(k.id)) || r.keymaps[0];
    await app.openRepoKeymap(km.file);
  });
  const clone = () => guarded(async () => {
    busy('Cloning… this can take a minute.');
    const r = await api('POST', '/api/clone', { url: urlInput.value });
    await app.refreshServer();
    const km = r.keymaps.find((k) => /corne/.test(k.id)) || r.keymaps[0];
    await app.openRepoKeymap(km.file);
    toast(`Cloned into ${r.path}`, 'ok');
  });
  const fileInput = h('input', { type: 'file', accept: '.keymap,.dtsi,.overlay,text/plain', onChange: async (e) => { const f = e.target.files[0]; if (!f) return; const text = await f.text(); guarded(async () => app.openText(text, f.name)); } });
  const body = h('div', { class: 'source' },
    !s ? h('p', { class: 'warn-text' }, 'The local server is not answering, so folders and git are unavailable.') : null,
    repo && !repo.missing && repo.keymaps.length ? block('Keymaps in ' + repo.path,
      h('div', { class: 'file-list' }, repo.keymaps.map((k) => h('button', { class: app.source.kind === 'repo' && app.source.file === k.file ? 'on' : '', onClick: () => guarded(() => app.openRepoKeymap(k.file)) }, code(k.file), k.layoutFile ? null : h('small', { class: 'warn-text' }, 'no layout file, keys are shown as a list'))))) : null,
    block('Use a zmk-config folder on this computer', h('p', { class: 'muted' }, 'The folder you cloned from GitHub. Saving writes to it, and the app can commit and push for you.'),
      h('div', { class: 'inline-form' }, pathInput, h('button', { class: 'primary', disabled: !s, onClick: useFolder }, 'Use this folder'))),
    block('Or clone it from GitHub', h('p', { class: 'muted' }, s ? `It is cloned into ${s.appDir}/repos using the git on this computer.` : ''),
      h('div', { class: 'inline-form' }, urlInput, h('button', { disabled: !s || !s.tools.git, onClick: clone }, 'Clone'))),
    block('Other ways in',
      h('div', { class: 'inline-form' }, h('label', { class: 'file-btn' }, 'Open a .keymap file', fileInput),
        h('button', { onClick: async () => { let t = ''; try { t = await navigator.clipboard.readText(); } catch { toast('The browser did not allow reading the clipboard.', 'error'); return; } guarded(async () => app.openText(t, 'pasted.keymap')); } }, 'Paste from clipboard'),
        h('button', { onClick: () => guarded(() => app.openBundled()) }, 'Open the bundled copy'))),
    msg);
  const m = modal({ title: 'Choose a keymap', body, wide: true });
}

// ---------- ZMK side ----------
export function zmkPanel(app) {
  const s = app.server;
  const repo = s && s.repo && !s.repo.missing ? s.repo : null;
  const inRepo = app.source.kind === 'repo' && repo;
  const st = inRepo ? repo.status : null;
  const el = h('aside', { class: 'side zmk', 'aria-label': 'Save and flash' });

  const copyOut = () => [
    h('button', { onClick: () => download(app.source.file.split('/').pop(), app.text, 'text/plain') }, 'Download .keymap'),
    h('button', { onClick: async () => { await navigator.clipboard.writeText(app.text); toast('Keymap copied.', 'ok'); } }, 'Copy as text'),
  ];

  if (!inRepo) {
    el.append(block('Keymap file',
      h('p', null, app.source.kind === 'bundled' ? `You are editing a bundled copy of your keymap (${app.source.note}).` : `You are editing ${app.source.file}, which is not connected to a folder.`),
      h('p', { class: 'muted' }, 'Connect your zmk-config folder to save straight into it, push to GitHub and flash from here.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'primary', onClick: () => sourceDialog(app) }, 'Connect a folder'), copyOut())));
    return el;
  }

  // 1. save
  el.append(block('Keymap file',
    h('p', { class: 'path' }, code(app.source.file), h('span', { class: `state ${app.dirty ? 'dirty' : ''}` }, app.dirty ? 'unsaved changes' : 'saved')),
    h('div', { class: 'btn-row' }, h('button', { class: 'primary', disabled: !app.dirty && !app.vialDirty, onClick: () => app.save() }, 'Save'), copyOut())));

  // 2. git
  if (st && st.git) {
    const mine = st.changed.filter((c) => c.file.startsWith('config/'));
    const msgInput = h('input', { type: 'text', placeholder: 'Update keymap', 'aria-label': 'Commit message' });
    const out = h('pre', { class: 'log', hidden: !app.gitLog }, app.gitLog || '');
    const act = async (label, fn) => { out.hidden = false; out.textContent = label + '…'; try { const r = await fn(); app.gitLog = r || 'Done.'; } catch (e) { app.gitLog = e.message; toast(e.message, 'error'); } await app.refreshServer(); app.render(); };
    const commitPush = () => act('Committing and pushing', async () => {
      if (app.dirty || app.vialDirty) { if (!(await app.save())) throw new Error('Save failed.'); }
      const files = (await api('GET', '/api/git/status')).changed.filter((c) => c.file.startsWith('config/')).map((c) => c.file);
      let log = '';
      if (files.length) { await api('POST', '/api/git/commit', { files, message: msgInput.value }); log += `Committed ${files.join(', ')}.\n`; }
      const r = await api('POST', '/api/git/push');
      toast('Pushed. GitHub is building the firmware.', 'ok');
      return log + (r.output || 'Pushed.');
    });
    el.append(block('Send to GitHub',
      h('p', { class: 'muted' }, `Branch ${st.branch}`, st.ahead ? `, ${st.ahead} commit${st.ahead > 1 ? 's' : ''} not pushed yet` : '', st.behind ? `, ${st.behind} behind GitHub` : '', '. ',
        mine.length || app.dirty ? `${app.dirty ? 'Unsaved edits' : mine.map((c) => c.file).join(', ')} will be committed.` : 'Nothing new to commit.'),
      msgInput,
      h('div', { class: 'btn-row' },
        h('button', { class: 'primary', disabled: !(mine.length || app.dirty || app.vialDirty || st.ahead), onClick: commitPush }, 'Commit and push'),
        st.behind ? h('button', { onClick: () => act('Pulling', async () => { const r = await api('POST', '/api/git/pull'); await app.openRepoKeymap(app.source.file); return r.output; }) }, 'Pull') : null,
        st.github ? h('a', { class: 'btn-link', href: st.github.url + '/actions', target: '_blank', rel: 'noopener' }, 'Open Actions on GitHub') : null),
      st.last ? h('p', { class: 'muted small' }, 'Last commit: ', code(st.last.hash), ' ', st.last.subject, ` (${st.last.when})`) : null,
      out));
  } else if (st) {
    el.append(block('Send to GitHub', h('p', { class: 'muted' }, st.reason + '. Saving still works; commit and push by hand.')));
  }

  // 3. builds + 4. flash
  el.append(firmwareBlock(app, st));
  return el;
}

function firmwareBlock(app, st) {
  const builds = h('div', { class: 'builds' });
  // The files from the GitHub build carry the board's name, which is also the name of the keymap file.
  const board = baseName(app).toLowerCase();

  const flash = async (f, v, known) => {
    const d = driveInfo(v, app.keyboardName);
    const problems = [];
    if (d.other) problems.push(`The half on "${v.name}" is running firmware for another keyboard (${d.other}).`);
    if (d.side && f.side && d.side !== f.side) problems.push(`The half on "${v.name}" is running ${d.side}-half firmware, and this file is for the ${f.side} half.`);
    // The settings reset wipes the half's memory. It gets its own question, and the server refuses it without the yes.
    let reset = false;
    if (f.reset) {
      if (!(await confirmDialog('Erase everything this half has stored?', 'Erase and flash', { danger: true, detail: `${f.name} is the settings reset. It wipes the memory of the half, Bluetooth pairings included, and the half does nothing useful until you flash its normal firmware again. Use it only when the two halves have lost each other or pairing is stuck.` }))) return;
      reset = true;
    }
    let force = false;
    if (problems.length) {
      if (!(await confirmDialog('This does not look like the right half for this file.', 'Flash anyway', { danger: true, detail: `${problems.join(' ')} Only go on if you are repairing a half that got the wrong firmware. ${f.name}` }))) return;
      force = true;
    } else if (!known || (f.side && !d.side)) {
      const notes = [];
      if (!known) notes.push('The app cannot tell from the file name that this is for your keyboard.');
      if (f.side && !d.side) notes.push(`The app could not read which half is on the drive, so make sure the half plugged in right now is the ${f.side} one.`);
      if (!(await confirmDialog(`Flash ${f.side ? `the ${f.side} firmware` : 'this firmware'} to "${v.name}"?`, 'Flash', { detail: `${notes.join(' ')} ${f.name}` }))) return;
    }
    try {
      const r = await api('POST', '/api/flash', { file: f.file, volume: v.path, board: known ? board : '', keyboard: app.keyboardName, force, reset });
      const eject = 'macOS may say the disk was not ejected properly, which is fine.';
      if (r.restarted === false) toast(`Copied ${r.copied}, but the drive is still there, so the half may not have taken it. Look at the half, then try again.`, 'error', 12000);
      else if (r.reset) toast(`The settings reset is on the half; it has forgotten its pairings. Put it in bootloader mode again and flash its normal firmware. ${eject}`, 'ok', 15000);
      else if (r.running === true) toast(`Flashed ${r.copied}. The half restarted and is running. ${eject}`, 'ok', 9000);
      else if (r.running === false && f.side === 'left') toast(`Copied ${r.copied} and the drive went away, but the half did not come back as a keyboard. If it does not work, put it in bootloader mode and flash it again.`, 'error', 15000);
      else toast(`Copied ${r.copied} and the half restarted. ${r.copyError ? 'The app could not confirm that all of it arrived, so check that the half works. ' : ''}${eject}`, 'ok', 9000);
    } catch (e) { toast(e.message, 'error', 12000); }
    app.watch.pollServer();
  };

  const flashButton = (f, v, known) => {
    const d = driveInfo(v, app.keyboardName);
    const wrong = !!d.other || !!(d.side && f.side && d.side !== f.side);
    return h('button', { class: wrong ? '' : 'primary', title: `Copy to ${v.path}`, onClick: () => flash(f, v, known) }, wrong ? `Not this half. Flash to ${v.name} anyway…` : `Flash to ${v.name}`);
  };

  // Redrawn whenever a drive appears, disappears, or the app finds out which half is on it.
  const files = h('div', { class: 'fw-files' });
  live(files, () => {
    const volumes = app.watch.conn.volumes;
    const usable = (app.fwFiles || []).filter((f) => f.valid);
    if (!usable.length) { files.replaceChildren(h('p', { class: 'muted' }, 'No firmware downloaded yet. Download a build above, or drop .uf2 files into the app\'s "firmware" folder.')); return; }
    const mine = usable.filter((f) => f.name.toLowerCase().includes(board));
    const known = mine.length > 0;
    const others = usable.length - mine.length;
    files.replaceChildren(...[
      known ? null : h('p', { class: 'warn-text small' }, `No file here has "${board}" in its name, so the app cannot tell which ones are for this keyboard. Read the name before you flash.`),
      h('ul', { class: 'fw-list' }, (known ? mine : usable).slice(0, 12).map((f) => h('li', null,
        h('span', null, f.side ? h('b', null, f.side === 'left' ? 'Left half' : 'Right half') : null, f.reset ? h('em', null, ' settings reset') : null, h('small', { class: 'tok' }, f.name)),
        h('span', { class: 'fw-act' }, f.sideConflict
          ? h('small', { class: 'warn-text' }, 'The name and the contents disagree about which half this is for. Not offered.')
          : volumes.filter((v) => !v.chip || !f.family || v.chip === f.family).map((v) => flashButton(f, v, known)))))),
      known && others ? h('p', { class: 'muted small' }, `${others} file${others > 1 ? 's' : ''} for other keyboards ${others > 1 ? 'are' : 'is'} in the firmware folder and not offered here.`) : null,
    ].filter(Boolean));
  });
  const loadFiles = async () => { try { app.fwFiles = (await api('GET', '/api/firmware')).files; } catch { /* server gone */ } files.redraw(); };

  const loadBuilds = async () => {
    builds.replaceChildren(h('p', { class: 'muted' }, 'Asking GitHub…'));
    try {
      const r = await api('GET', '/api/builds');
      if (!r.available) { builds.replaceChildren(h('p', { class: 'muted' }, r.reason), st && st.github ? h('a', { class: 'btn-link', href: st.github.url + '/actions', target: '_blank', rel: 'noopener' }, 'Download the firmware zip from GitHub Actions') : null); return; }
      if (!r.runs.length) { builds.replaceChildren(h('p', { class: 'muted' }, 'No builds yet.')); return; }
      builds.replaceChildren(h('ul', { class: 'run-list' }, r.runs.slice(0, 5).map((run) => {
        const state = run.status !== 'completed' ? 'building' : run.conclusion === 'success' ? 'ready' : run.conclusion || 'failed';
        return h('li', { class: 'run ' + state }, h('span', { class: 'run-state' }, state), h('span', { class: 'run-title' }, run.displayTitle, h('small', null, ` ${String(run.headSha).slice(0, 7)}, ${new Date(run.createdAt).toLocaleString()}`)),
          state === 'ready' ? h('button', { onClick: async (e) => { e.target.disabled = true; e.target.textContent = 'Downloading…'; try { await api('POST', '/api/builds/download', { runId: run.databaseId }); toast('Firmware downloaded.', 'ok'); await loadFiles(); } catch (err) { toast(err.message, 'error'); } e.target.disabled = false; e.target.textContent = 'Download'; } }, 'Download') : state === 'building' ? null : h('a', { class: 'btn-link', href: run.url, target: '_blank', rel: 'noopener' }, 'See why'));
      })));
    } catch (e) { builds.replaceChildren(h('p', { class: 'warn-text' }, e.message)); }
  };

  loadFiles();
  return h('div', null,
    block('Firmware builds', h('p', { class: 'muted' }, 'Every push makes GitHub build new firmware. It takes a few minutes.'), h('div', { class: 'btn-row' }, h('button', { onClick: loadBuilds }, 'Check builds')), builds),
    block(`Flash the ${app.keyboardName}`,
      h('ol', { class: 'steps-list' },
        h('li', null, 'Plug the left half into this computer with a USB cable.'),
        h('li', null, 'Press its reset button twice, quickly. A drive appears, and the app shows below which half it is.'),
        h('li', null, 'Flash the left file. The drive disappears and the half restarts.'),
        h('li', null, 'Do the same for the right half with the right file.')),
      connectionDetail(app, 'zmk'),
      h('div', { class: 'btn-row' }, h('button', { onClick: () => { app.watch.pollServer(); loadFiles(); } }, 'Look again')),
      files));
}

// ---------- Vial side ----------
export function vialPanel(app) {
  const tr = app.translation;
  const t = app.vialTarget;
  const el = h('aside', { class: 'side vial', 'aria-label': 'Vial keyboard' });
  const sum = tr.summary;
  const fatal = tr.issues.filter((i) => i.level === 'error');

  el.append(block(`${t.name}`,
    h('p', { class: 'summary' }, h('b', null, sum.ok), ` of ${sum.total} keys carry over exactly`, sum.approx ? [', ', h('b', { class: 'st-text st-approx' }, sum.approx), ' with a difference'] : null, sum.unsupported ? [', ', h('b', { class: 'st-text st-unsupported' }, sum.unsupported), ' have no equivalent'] : null, '.'),
    h('p', { class: 'muted' }, `${tr.macros.length} macro${tr.macros.length === 1 ? '' : 's'}, ${tr.tapDance.length} tap dance${tr.tapDance.length === 1 ? '' : 's'}, ${tr.combos.length} combo${tr.combos.length === 1 ? '' : 's'}, ${tr.keyOverrides.length} key override${tr.keyOverrides.length === 1 ? '' : 's'}.`),
    fatal.length ? h('ul', { class: 'row-issues' }, fatal.map((i) => h('li', { class: 'lv-error' }, i.message))) : null));

  // send
  const vilName = `${baseName(app)}-corne-mx-pro.vil`;
  const exportVil = async () => {
    const text = vilToText(buildVil(tr), t.uid);
    download(vilName, text, 'application/json');
    if (app.server) { try { const r = await api('POST', '/api/exports', { name: vilName, text }); toast(`Also saved to ${r.path}`, 'ok', 7000); } catch { /* download is enough */ } }
  };
  el.append(block('Send it to the keyboard',
    connectionDetail(app, 'vial'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'primary', disabled: fatal.length > 0, onClick: () => usbWizard(app) }, 'Write over USB'),
      h('button', { disabled: fatal.length > 0, onClick: exportVil }, 'Download .vil file')),
    h('p', { class: 'muted small' }, 'Write over USB makes a backup first and changes only what differs. Or load the .vil file in the Vial app with File, then Load saved layout.'),
    WebHidTransport.supported() ? null : h('p', { class: 'warn-text small' }, 'This browser has no USB keyboard access (WebHID). Use Chrome, Edge or Brave for "Write over USB", or use the .vil file.')));

  // issues
  const groups = [['unsupported', 'No equivalent on this keyboard'], ['warn', 'Works, with a difference'], ['info', 'Good to know']];
  for (const [level, title] of groups) {
    const list = tr.issues.filter((i) => i.level === level);
    if (!list.length) continue;
    el.append(h('details', { class: 'block issues', open: level !== 'info' }, h('summary', null, `${title} (${list.length})`),
      h('ul', null, list.map((i) => h('li', { class: 'lv-' + level }, i.where.layer !== undefined && i.where.pos !== undefined
        ? h('button', { class: 'link', onClick: () => { app.tab = 'keys'; app.layer = i.where.layer; app.render(); } }, i.message)
        : i.message)))));
  }

  // options
  const v = app.vial;
  el.append(h('details', { class: 'block' }, h('summary', null, 'Options for this keyboard'),
    h('div', { class: 'opt-grid' },
      t.layoutOptions.map((o, i) => field(o.label, h('select', { onChange: (e) => { const c = [...(v.layoutChoices || t.layoutOptions.map(() => 0))]; c[i] = Number(e.target.value); app.setVial({ layoutChoices: c }); } }, o.choices.map((c, k) => h('option', { value: k, selected: ((v.layoutChoices || [])[i] || 0) === k }, c)))))),
    v.layoutChoices ? null : h('p', { class: 'muted small' }, 'Until you change one of these, writing over USB leaves the keyboard\'s own choice alone.'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: v.swapEncoders, onChange: (e) => app.setVial({ swapEncoders: e.target.checked }) }), 'Swap encoder directions'),
    field('Pauses inside macros', h('select', { onChange: (e) => app.setVial({ macroDelays: e.target.value }) },
      [['explicit', 'Only where the macro sets wait-ms'], ['always', 'Between every step (15 ms if not set)'], ['never', 'None']].map(([val, lab]) => h('option', { value: val, selected: v.macroDelays === val }, lab)))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: v.clearUnused, onChange: (e) => app.setVial({ clearUnused: e.target.checked }) }), 'When writing over USB, clear tap dances, combos and overrides that are not in this keymap')));

  if (tr.settingsInfo.length) {
    el.append(h('details', { class: 'block' }, h('summary', null, 'Tap-hold timings'),
      h('p', { class: 'muted small' }, 'QMK has one set of timings for the whole keyboard. These come from your ZMK behaviors; untick any you would rather set in Vial yourself.'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: v.applySettings, onChange: (e) => app.setVial({ applySettings: e.target.checked }) }), 'Send these settings'),
      h('table', { class: 'settings' }, tr.settingsInfo.map((s) => h('tr', { class: s.enabled ? '' : 'off' },
        h('td', null, h('input', { type: 'checkbox', 'aria-label': s.title, checked: !v.skipSettings.includes(s.qsid), disabled: !v.applySettings, onChange: (e) => app.setVial({ skipSettings: e.target.checked ? v.skipSettings.filter((q) => q !== s.qsid) : [...v.skipSettings, s.qsid] }) })),
        h('td', null, s.title, h('small', { class: 'muted' }, ` from ${s.from}`)),
        h('td', { class: 'tok' }, String(s.value)))))));
  }

  el.append(block('Flashing new firmware onto it',
    h('p', { class: 'muted small' }, 'You only need this to update Keebart\'s firmware itself, not to change keys. Hold Q (left half) or P (right half) while plugging that half in, or hold BOOT and tap RESET through the two small holes on the underside. A drive named RPI-RP2 appears; copy the same .uf2 file to each half.')));
  return el;
}

// ---------- writing over USB ----------
function usbWizard(app) {
  const t = app.vialTarget;
  const body = h('div', { class: 'usb' });
  let kb = null; let transport = null; let cancelled = false; let unlocking = false; let writing = false; let busy = false;
  // the top-bar check must not talk to the keyboard while this dialog does
  const quiet = app.watch.pause();
  const say = (...c) => body.replaceChildren(...c.filter((x) => x !== null && x !== undefined && x !== false));
  const progress = (label, frac) => h('div', { class: 'progress-line' }, h('span', null, label), h('progress', frac === undefined ? {} : { value: frac, max: 1 }));
  const finish = async () => {
    cancelled = true;
    // the firmware cannot call an unlock off; until the keys are held or the cable is pulled it ignores everything else
    if (unlocking) toast('The unlock was not finished. The keyboard keeps waiting for it and ignores this app until you unplug it and plug it back in. Typing still works.', 'info', 12000);
    if (transport) await transport.close();
    app.watch.resume();
  };
  // Which half the cable is in, and what that means for where the keymap goes.
  const where = (state) => {
    const side = sideOf(state, t) || vialStatus(app.watch.conn, t).marked;
    return h('p', { class: 'muted small' }, side ? h('b', null, `Plugged in: the ${side} half. `) : 'The app does not know yet whether this is the left or the right half. ',
      'The keymap is stored in the half the USB cable is in. If you sometimes plug the cable into the other half, write to that one as well.');
  };
  // Escape or a click beside the dialog must not cut a write off half-way: the keyboard would be left with a mix
  // The same goes for the unlock: the two keys that are held for it still type, and one of them can be Escape.
  const canClose = (how) => {
    if (writing) { if (how !== 'escape') toast('Still writing to the keyboard. This takes a few seconds.', 'info'); return false; }
    return !(unlocking && !cancelled && how === 'escape');
  };
  const m = modal({ title: `Write to the ${t.name}`, body, onClose: finish, canClose, cls: 'usb-dialog' });
  const fail = (e) => say(h('p', { class: 'warn-text' }, e.message || String(e)), h('div', { class: 'btn-row' }, h('button', { onClick: () => m.close() }, 'Close')));

  const start = async () => {
    try {
      await quiet;
      say(progress('Waiting for you to pick the keyboard in the browser prompt…'));
      transport = await WebHidTransport.request();
      kb = new VialKeyboard(transport, app.qmk);
      say(progress('Reading the keyboard…'));
      const state = await kb.readState(t, (label) => say(progress(label + '…')));
      const backupName = `backup-${baseName(app)}-corne-mx-pro-${stamp()}.vil`;
      const backupText = vilToText(kb.stateToVil(state, t), state.uid);
      // No write without a backup that is known to be on disk. The browser does not say whether a download
      // worked, so the copy that counts is the one the server writes and confirms.
      let saved = null;
      if (app.server) {
        try { saved = (await api('POST', '/api/exports', { name: backupName, text: backupText })).path; }
        catch (e) { throw new Error(`The backup could not be saved (${e.message}). Nothing was written to the keyboard.`); }
      }
      download(backupName, backupText, 'application/json');
      review(state, saved ? `${saved} and your Downloads folder` : `your Downloads folder as ${backupName} (check that the file is there before you go on)`);
    } catch (e) { fail(e); }
  };

  const review = (state, savedAt) => {
    const plan = kb.plan(app.translation, state, t, { clearUnused: app.vial.clearUnused });
    const s = plan.summary;
    const rows = [['Keys', s.keys], ['Encoder actions', s.encoders], ['Tap dances', s.tapDances], ['Combos', s.combos], ['Key overrides', s.keyOverrides], ['Macros', s.macros ? 'rewritten' : 0], ['Settings', s.settings], ['Layout options', s.layoutOptions]].filter(([, n]) => n);
    if (!plan.ops.length) {
      say(h('p', { class: 'ok-text' }, 'The keyboard already matches this keymap. Nothing to write.'), where(state), h('p', { class: 'muted small' }, `A backup was still saved to ${savedAt}.`), h('div', { class: 'btn-row' }, h('button', { class: 'primary', onClick: () => m.close() }, 'Done')));
      return;
    }
    say(h('p', null, 'A backup of the keyboard as it is now was saved to ', code(savedAt), '. Load it in Vial to go back.'),
      where(state),
      h('table', { class: 'settings' }, rows.map(([k, n]) => h('tr', null, h('td', null, k), h('td', { class: 'tok' }, typeof n === 'number' ? `${n} to change` : n)))),
      plan.notes.length ? h('ul', { class: 'row-issues' }, plan.notes.map((n) => h('li', { class: 'lv-warn' }, n))) : null,
      plan.needsUnlock ? h('p', { class: 'muted small' }, 'Macros can only be changed while the keyboard is unlocked. You will be asked to hold two keys.') : null,
      h('div', { class: 'btn-row' }, h('button', { onClick: () => m.close() }, 'Cancel'), h('button', { class: 'primary', onClick: () => write(plan).catch(fail) }, `Write ${plan.ops.length} change${plan.ops.length > 1 ? 's' : ''}`)));
  };

  // Locks the keyboard again and checks that it took.
  const relock = async () => { try { await kb.lock(); return !(await kb.unlockStatus()).unlocked; } catch { return false; } };

  const write = async (plan) => {
    if (busy) return;   // a second click on the button
    busy = true;
    let after = null; let left = null; let locked = true;
    try {
      // Asked now, not taken from the earlier read: macros can only be written while the keyboard is unlocked.
      const st = plan.needsUnlock ? await kb.unlockStatus() : null;
      if (st && !st.unlocked) {
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();   // the held keys must not press a button
        const idx = new Set(st.keys.map(([r, c]) => t.positions.findIndex(([pr, pc]) => pr === r && pc === c)));
        const caps = app.km.layout.map((_, i) => ({ kind: idx.has(i) ? 'alpha' : 'ghost', selected: idx.has(i), main: idx.has(i) ? 'hold' : '' }));
        const bar = h('progress', { value: 0, max: 1 });
        say(h('p', null, 'Press and hold the two highlighted keys until the bar fills.'), h('div', { class: 'mat vial' }, keyboardView({ layout: app.km.layout, caps, interactive: false, maxUnit: 30 })), bar,
          h('p', { class: 'muted small' }, 'The two keys still type while you hold them. That does no harm here.'),
          h('div', { class: 'btn-row' }, h('button', { onClick: () => { cancelled = true; m.close(); } }, 'Cancel')));
        unlocking = true;
        const okUnlock = await kb.unlock({ onProgress: (f) => { bar.value = f; }, shouldCancel: () => cancelled });
        if (!okUnlock) return;
        unlocking = false;
      }
      const bar = h('progress', { value: 0, max: 1 });
      say(h('p', null, 'Writing… Leave the keyboard plugged in.'), bar);
      writing = true;
      await kb.apply(plan, (f) => { bar.value = f; });
      say(progress('Checking what the keyboard stored…'));
      after = await kb.readState(t);
      left = kb.plan(app.translation, after, t, { clearUnused: app.vial.clearUnused });
    } finally {
      // Whatever happened above (a lost answer during the unlock included), do not leave the keyboard unlocked.
      // After a cancelled unlock there is nothing to lock, and the keyboard is already closed.
      if (plan.needsUnlock && !cancelled) locked = await relock();
      if (after) after.unlocked = !locked;
      writing = false; unlocking = false; busy = false;
      if (!locked) toast('The app could not lock the keyboard again. Unplug it and plug it back in; that locks it.', 'error', 12000);
    }
    if (left.ops.length) {
      say(h('p', { class: 'warn-text' }, `${left.ops.length} change${left.ops.length > 1 ? 's' : ''} did not stick (${[...new Set(left.ops.map((o) => o.type))].join(', ')}).`),
        h('p', { class: 'muted' }, 'Everything else was written. You can try again, or load the .vil file in Vial instead.'),
        h('div', { class: 'btn-row' }, h('button', { onClick: () => m.close() }, 'Close'), h('button', { class: 'primary', onClick: () => write(left).catch(fail) }, 'Try again')));
      return;
    }
    say(h('p', { class: 'ok-text' }, `Done. ${plan.ops.length} change${plan.ops.length > 1 ? 's' : ''} written and checked.`), h('p', { class: 'muted' }, 'The new keymap is active right away. No flashing needed.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'primary', onClick: () => m.close() }, 'Done')));
  };

  say(h('p', null, `Plug in the ${t.name} by USB. The browser will ask which device to use; pick the keyboard.`),
    h('p', { class: 'muted small' }, 'Close the Vial app or vial.rocks first if it is open, so only one program talks to the keyboard.'),
    h('div', { class: 'btn-row' }, h('button', { onClick: () => m.close() }, 'Cancel'), h('button', { class: 'primary', onClick: start }, 'Connect keyboard')));
}
