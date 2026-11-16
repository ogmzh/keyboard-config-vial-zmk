// What each ZMK behavior is called and which parameters it takes.
// Parameter types: 'code' (a key), 'mod' (a modifier key), 'layer', 'command', 'int'.

const cmd = (list) => Object.fromEntries(list.map(([code, title, extra]) => [code, { title, extra: extra || [] }]));

export const BUILTIN_BEHAVIORS = {
  kp: { title: 'Key Press', params: ['code'] },
  mt: { title: 'Mod-Tap', params: ['mod', 'code'], hint: 'Hold for a modifier, tap for a key' },
  lt: { title: 'Layer-Tap', params: ['layer', 'code'], hint: 'Hold for a layer, tap for a key' },
  mo: { title: 'Momentary Layer', params: ['layer'] },
  to: { title: 'To Layer', params: ['layer'] },
  tog: { title: 'Toggle Layer', params: ['layer'] },
  sl: { title: 'Sticky Layer', params: ['layer'], hint: 'Layer stays on for the next key press' },
  sk: { title: 'Sticky Key', params: ['code'], hint: 'One-shot modifier: applies to the next key press' },
  kt: { title: 'Key Toggle', params: ['code'] },
  trans: { title: 'Transparent', params: [], hint: 'Falls through to the layer below' },
  none: { title: 'None', params: [], hint: 'Does nothing' },
  caps_word: { title: 'Caps Word', params: [], hint: 'Capitalises until the end of the word' },
  key_repeat: { title: 'Key Repeat', params: [] },
  gresc: { title: 'Grave / Escape', params: [] },
  bt: {
    title: 'Bluetooth', params: ['command'],
    commands: cmd([
      ['BT_SEL', 'Select profile', ['int']], ['BT_CLR', 'Clear current profile'], ['BT_CLR_ALL', 'Clear all profiles'],
      ['BT_NXT', 'Next profile'], ['BT_PRV', 'Previous profile'], ['BT_DISC', 'Disconnect profile', ['int']],
    ]),
  },
  out: { title: 'Output Selection', params: ['command'], commands: cmd([['OUT_USB', 'USB'], ['OUT_BLE', 'Bluetooth'], ['OUT_TOG', 'Toggle USB / Bluetooth']]) },
  ext_power: { title: 'External Power', params: ['command'], commands: cmd([['EP_ON', 'On'], ['EP_OFF', 'Off'], ['EP_TOG', 'Toggle']]) },
  rgb_ug: {
    title: 'RGB Underglow', params: ['command'],
    commands: cmd([
      ['RGB_TOG', 'Toggle'], ['RGB_ON', 'On'], ['RGB_OFF', 'Off'], ['RGB_HUI', 'Hue +'], ['RGB_HUD', 'Hue −'],
      ['RGB_SAI', 'Saturation +'], ['RGB_SAD', 'Saturation −'], ['RGB_BRI', 'Brightness +'], ['RGB_BRD', 'Brightness −'],
      ['RGB_SPI', 'Speed +'], ['RGB_SPD', 'Speed −'], ['RGB_EFF', 'Next effect'], ['RGB_EFR', 'Previous effect'],
      ['RGB_COLOR_HSB', 'Set colour (hue, saturation, brightness)', ['fn3']],
    ]),
  },
  bl: {
    title: 'Backlight', params: ['command'],
    commands: cmd([
      ['BL_TOG', 'Toggle'], ['BL_ON', 'On'], ['BL_OFF', 'Off'], ['BL_INC', 'Brightness +'], ['BL_DEC', 'Brightness −'],
      ['BL_CYCLE', 'Cycle brightness'], ['BL_SET', 'Set brightness', ['int']],
    ]),
  },
  mkp: { title: 'Mouse Button', params: ['command'], commands: cmd([['LCLK', 'Left click'], ['RCLK', 'Right click'], ['MCLK', 'Middle click'], ['MB4', 'Button 4'], ['MB5', 'Button 5']]) },
  mmv: { title: 'Mouse Move', params: ['command'], commands: cmd([['MOVE_UP', 'Up'], ['MOVE_DOWN', 'Down'], ['MOVE_LEFT', 'Left'], ['MOVE_RIGHT', 'Right']]) },
  msc: { title: 'Mouse Scroll', params: ['command'], commands: cmd([['SCRL_UP', 'Up'], ['SCRL_DOWN', 'Down'], ['SCRL_LEFT', 'Left'], ['SCRL_RIGHT', 'Right']]) },
  bootloader: { title: 'Bootloader', params: [], hint: 'Restart into flashing mode' },
  sys_reset: { title: 'Reset', params: [], hint: 'Restart the keyboard' },
  soft_off: { title: 'Soft Off', params: [] },
  studio_unlock: { title: 'ZMK Studio Unlock', params: [] },
  inc_dec_kp: { title: 'Encoder Key Press', params: ['code', 'code'], sensor: true, hint: 'First key when turned clockwise, second when turned counter-clockwise' },
  // macro controls
  macro_tap: { title: 'Macro: tap mode', params: [], macro: true },
  macro_press: { title: 'Macro: press mode', params: [], macro: true },
  macro_release: { title: 'Macro: release mode', params: [], macro: true },
  macro_pause_for_release: { title: 'Macro: pause until key release', params: [], macro: true },
  macro_tap_time: { title: 'Macro: tap time (ms)', params: ['int'], macro: true },
  macro_wait_time: { title: 'Macro: wait time (ms)', params: ['int'], macro: true },
  macro_param_1to1: { title: 'Macro: pass parameter 1 → 1', params: [], macro: true },
  macro_param_1to2: { title: 'Macro: pass parameter 1 → 2', params: [], macro: true },
  macro_param_2to1: { title: 'Macro: pass parameter 2 → 1', params: [], macro: true },
  macro_param_2to2: { title: 'Macro: pass parameter 2 → 2', params: [], macro: true },
};

// Forms for custom behaviors, by devicetree "compatible".
export const BEHAVIOR_TYPES = {
  'zmk,behavior-hold-tap': {
    title: 'Hold-Tap', cells: 2, prefix: 'ht',
    fields: [
      { name: 'bindings', type: 'refs', count: 2, labels: ['Hold behavior', 'Tap behavior'], default: ['kp', 'kp'] },
      { name: 'flavor', type: 'enum', label: 'Flavor', options: ['hold-preferred', 'balanced', 'tap-preferred', 'tap-unless-interrupted'], default: 'hold-preferred' },
      { name: 'tapping-term-ms', type: 'int', default: 200, label: 'Tapping term (ms)' },
      { name: 'quick-tap-ms', type: 'int', label: 'Quick tap (ms)' },
      { name: 'require-prior-idle-ms', type: 'int', label: 'Require prior idle (ms)' },
      { name: 'retro-tap', type: 'bool', label: 'Retro tap' },
      { name: 'hold-while-undecided', type: 'bool', label: 'Hold while undecided' },
      { name: 'hold-trigger-key-positions', type: 'positions', label: 'Hold trigger key positions' },
      { name: 'hold-trigger-on-release', type: 'bool', label: 'Hold trigger on release' },
    ],
  },
  'zmk,behavior-tap-dance': {
    title: 'Tap Dance', cells: 0, prefix: 'td',
    fields: [
      { name: 'bindings', type: 'bindings', label: 'Bindings (1 tap, 2 taps, …)', default: [{ behavior: 'kp', params: ['A'] }, { behavior: 'kp', params: ['B'] }] },
      { name: 'tapping-term-ms', type: 'int', default: 200, label: 'Tapping term (ms)' },
    ],
  },
  'zmk,behavior-mod-morph': {
    title: 'Mod-Morph', cells: 0, prefix: 'mm',
    fields: [
      { name: 'bindings', type: 'bindings', label: 'Sends', count: 2, labels: ['Normal', 'With modifier held'], default: [{ behavior: 'kp', params: ['A'] }, { behavior: 'kp', params: ['B'] }] },
      { name: 'mods', type: 'mods', label: 'Modifiers that trigger the morph', default: ['MOD_LSFT', 'MOD_RSFT'] },
      { name: 'keep-mods', type: 'mods', label: 'Modifiers to keep active' },
    ],
  },
  'zmk,behavior-sticky-key': {
    title: 'Sticky Key', cells: 1, prefix: 'sk',
    fields: [
      { name: 'bindings', type: 'refs', count: 1, labels: ['Behavior'], default: ['kp'] },
      { name: 'release-after-ms', type: 'int', default: 1000, label: 'Release after (ms)' },
      { name: 'quick-release', type: 'bool', label: 'Quick release' },
      { name: 'lazy', type: 'bool', label: 'Lazy' },
      { name: 'ignore-modifiers', type: 'bool', label: 'Ignore modifiers' },
    ],
  },
  'zmk,behavior-caps-word': {
    title: 'Caps Word', cells: 0, prefix: 'cw',
    fields: [
      { name: 'continue-list', type: 'codes', label: 'Keys that do not end caps word' },
      { name: 'mods', type: 'mods', label: 'Modifiers to apply' },
    ],
  },
  'zmk,behavior-key-repeat': { title: 'Key Repeat', cells: 0, prefix: 'kr', fields: [] },
  'zmk,behavior-sensor-rotate': {
    title: 'Sensor Rotation', cells: 0, prefix: 'rot',
    fields: [
      { name: 'bindings', type: 'bindings', label: 'Sends', count: 2, labels: ['Clockwise', 'Counter-clockwise'], default: [{ behavior: 'kp', params: ['PG_UP'] }, { behavior: 'kp', params: ['PG_DN'] }] },
      { name: 'tap-ms', type: 'int', label: 'Tap time (ms)' },
    ],
  },
  'zmk,behavior-sensor-rotate-var': {
    title: 'Sensor Rotation (with parameters)', cells: 2, prefix: 'rotv',
    fields: [{ name: 'bindings', type: 'refs', count: 2, labels: ['Clockwise behavior', 'Counter-clockwise behavior'], default: ['kp', 'kp'] }],
  },
  'zmk,behavior-macro': {
    title: 'Macro', cells: 0, prefix: 'macro', macro: true,
    fields: [
      { name: 'bindings', type: 'bindings', label: 'Steps', default: [{ behavior: 'kp', params: ['A'] }] },
      { name: 'wait-ms', type: 'int', label: 'Wait between steps (ms)' },
      { name: 'tap-ms', type: 'int', label: 'Tap duration (ms)' },
    ],
  },
  'zmk,behavior-macro-one-param': { title: 'Macro (one parameter)', cells: 1, prefix: 'macro', macro: true, fields: [] },
  'zmk,behavior-macro-two-param': { title: 'Macro (two parameters)', cells: 2, prefix: 'macro', macro: true, fields: [] },
};
BEHAVIOR_TYPES['zmk,behavior-macro-one-param'].fields = BEHAVIOR_TYPES['zmk,behavior-macro'].fields;
BEHAVIOR_TYPES['zmk,behavior-macro-two-param'].fields = BEHAVIOR_TYPES['zmk,behavior-macro'].fields;

export const MOD_FLAGS = ['MOD_LCTL', 'MOD_LSFT', 'MOD_LALT', 'MOD_LGUI', 'MOD_RCTL', 'MOD_RSFT', 'MOD_RALT', 'MOD_RGUI'];
