// What to print on a keycap for a ZMK binding, and how to say it in a sentence.

import { parseBindings } from '../core/keymap.js';
import { propTokens } from '../core/dts.js';
import { BUILTIN_BEHAVIORS } from '../core/behaviors.js';

const SHORT_CMD = {
  BT_SEL: 'BT', BT_CLR: 'BT clear', BT_CLR_ALL: 'BT clear all', BT_NXT: 'BT next', BT_PRV: 'BT prev', BT_DISC: 'BT off',
  OUT_USB: 'USB', OUT_BLE: 'BLE', OUT_TOG: 'USB/BLE', EP_ON: 'Pwr on', EP_OFF: 'Pwr off', EP_TOG: 'Pwr',
  RGB_TOG: 'RGB', RGB_ON: 'RGB on', RGB_OFF: 'RGB off', RGB_HUI: 'Hue +', RGB_HUD: 'Hue −', RGB_SAI: 'Sat +', RGB_SAD: 'Sat −',
  RGB_BRI: 'Bri +', RGB_BRD: 'Bri −', RGB_SPI: 'Spd +', RGB_SPD: 'Spd −', RGB_EFF: 'Effect +', RGB_EFR: 'Effect −',
  BL_TOG: 'Light', BL_ON: 'Light on', BL_OFF: 'Light off', BL_INC: 'Light +', BL_DEC: 'Light −', BL_CYCLE: 'Light cycle', BL_SET: 'Light =',
  LCLK: 'Click', RCLK: 'R-click', MCLK: 'M-click', MB4: 'Btn 4', MB5: 'Btn 5',
  MOVE_UP: 'Mouse ↑', MOVE_DOWN: 'Mouse ↓', MOVE_LEFT: 'Mouse ←', MOVE_RIGHT: 'Mouse →',
  SCRL_UP: 'Scroll ↑', SCRL_DOWN: 'Scroll ↓', SCRL_LEFT: 'Scroll ←', SCRL_RIGHT: 'Scroll →',
};
const LAYER_VERB = { mo: 'hold', to: 'go to', tog: 'toggle', sl: 'next key' };
const SIMPLE = { caps_word: 'Caps Word', key_repeat: 'Repeat', gresc: 'Esc `', bootloader: 'Boot', sys_reset: 'Reset', soft_off: 'Off', studio_unlock: 'Studio' };

// -> { tag, main, sub, kind, title }   kind: alpha | mod | layer | macro | system | trans | none | unknown
export function describe(b, km, zk) {
  if (!b) return { tag: '', main: '', kind: 'none', title: 'No binding' };
  const info = km.behavior(b.behavior);
  const p = b.params;
  const layerName = (t) => { const n = km.resolveLayer(t); const l = n !== null ? km.layers[n] : null; return l ? l.label : String(t); };
  const tag = '&' + b.behavior;
  if (info.unknown) return { tag, main: p.join(' ') || b.behavior, kind: 'unknown', title: `Unknown behavior &${b.behavior}` };

  const holdTap = (holdName, tapName, hold, tap) => {
    const hInfo = km.behavior(holdName);
    const t = describe({ behavior: tapName, params: [tap] }, km, zk);
    let sub;
    if (hInfo.builtin && holdName === 'mo') sub = '▾ ' + layerName(hold);
    else sub = describe({ behavior: holdName, params: [hold] }, km, zk).main;
    return { tag, main: t.main, sub, kind: 'alpha', title: `Tap: ${t.title}. Hold: ${hInfo.builtin && holdName === 'mo' ? 'layer ' + layerName(hold) : zk.describe(hold || '')}` };
  };

  if (info.custom) {
    const refs = parseBindings(propTokens(info.node, 'bindings'));
    switch (info.compatible) {
      case 'zmk,behavior-hold-tap': return holdTap((refs[0] || {}).behavior || 'kp', (refs[1] || {}).behavior || 'kp', p[0], p[1]);
      case 'zmk,behavior-sticky-key': {
        const inner = describe({ behavior: (refs[0] || {}).behavior || 'kp', params: [p[0]] }, km, zk);
        return { tag, main: inner.main, sub: 'one-shot', kind: 'mod', title: `One-shot ${inner.title}` };
      }
      case 'zmk,behavior-macro': case 'zmk,behavior-macro-one-param': case 'zmk,behavior-macro-two-param':
        return { tag: '', main: b.behavior.replace(/_/g, ' '), sub: 'macro', kind: 'macro', title: `Macro ${b.behavior}` };
      case 'zmk,behavior-tap-dance': return { tag: '', main: b.behavior.replace(/_/g, ' '), sub: 'tap dance', kind: 'macro', title: `Tap dance ${b.behavior}` };
      case 'zmk,behavior-mod-morph': {
        const a = refs[0] ? describe(refs[0], km, zk) : { main: '?' };
        const c = refs[1] ? describe(refs[1], km, zk) : { main: '?' };
        return { tag: '', main: a.main, sub: '⇧ ' + c.main, kind: 'alpha', title: `Mod-morph ${b.behavior}: ${a.title || a.main}, with the modifier: ${c.title || c.main}` };
      }
      default: return { tag, main: p.join(' ') || b.behavior, kind: 'system', title: `${info.title} ${b.behavior}` };
    }
  }

  switch (b.behavior) {
    case 'kp': {
      const parsed = zk.parse(p[0] || '');
      const mod = parsed.entry && parsed.entry.page === 7 && ((parsed.entry.id >= 224 && parsed.entry.id <= 231) || [40, 41, 42, 43, 44, 57].includes(parsed.entry.id) || (parsed.entry.id >= 73 && parsed.entry.id <= 82));
      return { tag: '', main: zk.label(p[0] || ''), kind: parsed.entry ? (mod ? 'mod' : 'alpha') : 'unknown', title: zk.describe(p[0] || '') };
    }
    case 'trans': return { tag: '', main: '▽', kind: 'trans', title: 'Transparent: uses the key from the layer below' };
    case 'none': return { tag: '', main: '', kind: 'none', title: 'None: does nothing' };
    case 'mt': return holdTap('kp', 'kp', p[0], p[1]);
    case 'lt': return holdTap('mo', 'kp', p[0], p[1]);
    case 'mo': case 'to': case 'tog': case 'sl':
      return { tag, main: layerName(p[0]), sub: LAYER_VERB[b.behavior], kind: 'layer', title: `${info.title}: ${layerName(p[0])}` };
    case 'sk': return { tag, main: zk.label(p[0] || ''), sub: 'one-shot', kind: 'mod', title: `One-shot ${zk.describe(p[0] || '')}` };
    case 'kt': return { tag, main: zk.label(p[0] || ''), sub: 'toggle', kind: 'mod', title: `Toggle ${zk.describe(p[0] || '')}` };
    case 'inc_dec_kp': return { tag, main: `${zk.label(p[0] || '')} / ${zk.label(p[1] || '')}`, kind: 'system', title: `Clockwise: ${zk.describe(p[0] || '')}. Counter-clockwise: ${zk.describe(p[1] || '')}` };
    default: {
      if (SIMPLE[b.behavior]) return { tag: '', main: SIMPLE[b.behavior], kind: 'system', title: info.title + (info.hint ? ': ' + info.hint : '') };
      if (info.commands) {
        const fn = /^(\w+)\((.*)\)$/.exec(p[0] || '');
        const cmd = fn ? fn[1] : p[0];
        const short = fn ? 'Colour' : (SHORT_CMD[cmd] || cmd || '?') + (p[1] !== undefined ? ' ' + p[1] : '');
        const c = info.commands[cmd];
        return { tag: '', main: short, kind: 'system', title: `${info.title}: ${c ? c.title : cmd}${fn ? ` (${fn[2]})` : ''}${p[1] !== undefined ? ' ' + p[1] : ''}` };
      }
      return { tag, main: p.join(' ') || (BUILTIN_BEHAVIORS[b.behavior] || {}).title || b.behavior, kind: 'system', title: info.title };
    }
  }
}

export const PARAM_LABELS = {
  mt: ['Hold: modifier', 'Tap: key'], lt: ['Hold: layer', 'Tap: key'], inc_dec_kp: ['Clockwise', 'Counter-clockwise'],
  'zmk,behavior-hold-tap': ['Hold', 'Tap'], 'zmk,behavior-sensor-rotate-var': ['Clockwise', 'Counter-clockwise'],
};
export function paramLabels(info) {
  const custom = PARAM_LABELS[info.name] || PARAM_LABELS[info.compatible];
  return (info.params || []).map((t, i) => (custom && custom[i]) || { code: 'Key', mod: 'Modifier', layer: 'Layer', command: 'Action', int: 'Value' }[t] || 'Value');
}
