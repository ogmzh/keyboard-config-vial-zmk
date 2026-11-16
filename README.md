# Keymap Bridge

One keymap, two keyboards. Edit your ZMK keymap in the browser, then send it to

- the **Corne Choc Pro BT** (ZMK, wireless): save, commit, push, download the build, flash the UF2 files;
- the **Corne MX Pro** (Vial/QMK, wired): write it straight over USB, or export a `.vil` file for the Vial app.

The ZMK `.keymap` file in your zmk-config repository stays the single source of truth. The Vial side is
worked out from it every time, and the app shows which keys carry over exactly and which do not.

## Run it

You need Node.js 18 or newer. Nothing to install.

```sh
cd keymap-bridge
npm start
```

It opens http://localhost:4777 in your browser. Stop it with Ctrl+C. Use `PORT=4788 npm start` for another port
and `npm start -- --no-open` to keep it from opening a browser tab.

The first time, it shows a bundled copy of your keymap (ogmzh/zmk-config, commit 71bcf77, 16 Nov 2026).
Click the file name in the top bar and either point it at your zmk-config folder or let it clone the repository.
After that, Save writes into that folder.

## What you can edit

Everything the nickcoutsos keymap editor covers:

- **Keys**: every layer, with a search for behaviors and keys, modifier toggles, "press a key to pick it",
  layers to add, rename, reorder and delete (layer numbers in `&mo`, `&lt`, combos and so on follow along);
- **Encoders** per layer;
- **Combos**: keys, what they send, layers, timeout;
- **Macros**: steps, wait and tap times;
- **Behaviors**: hold-tap, tap dance, mod-morph, sticky key, caps word and sensor rotation, with their settings;
- **Conditional layers**.

Undo and redo work across all of it (Cmd+Z, Shift+Cmd+Z). Cmd+S saves.
Saving rewrites only the properties you changed, in the same column layout the nickcoutsos editor uses,
so the git diff stays small. Comments and anything the app does not understand are left exactly as they are.

## Corne Choc Pro BT (ZMK)

The panel on the right walks through it:

1. **Save**, then **Commit and push**. It uses the git on your computer, with your own credentials.
2. **Check builds** lists the GitHub Actions runs and downloads the firmware. This needs the GitHub CLI
   (`brew install gh`, then `gh auth login`). Without it, download the zip from the Actions page and put the
   `.uf2` files in the `firmware` folder here.
3. **Flash**: plug in the left half, double-tap its reset button, and click "Flash to …" on the left file
   when the drive shows up. Repeat with the right half.

Before it copies anything, the app checks four things, and refuses when one is wrong:

- the file is whole: every block of it is read, so a download that was cut short, or a file that would write
  outside the application area of the chip, is not copied;
- the firmware is for the kind of chip on the drive, so ZMK firmware cannot land on the MX Pro;
- the file is for this keyboard: its name has to contain the board name (`corne_choc_pro`). Files for other
  keyboards from the same build (Sofle, Piantor) are not offered;
- the file is for the half that is on the drive. The app reads the firmware that half is running now
  (`CURRENT.UF2` on the drive) and compares: left file to left half, right file to right half.

If you are repairing a half that got the wrong firmware, "Flash anyway" is still there, behind a warning.
When the app cannot read which half is on the drive, it asks you to check by eye, as before.
The settings reset (`settings_reset-…`) erases everything a half has stored, Bluetooth pairings included.
It has its own warning, and the half needs its normal firmware again afterwards.
After the copy the app waits for the drive to disappear, and on macOS for the half to come back as a
keyboard. It tells you which of the two it saw; it does not call a copy a success because the drive went away.

Only the left half shows up in your Mac's Bluetooth list. The right half talks to the left one.

## Corne MX Pro (Vial)

Switch the target at the top. The board now shows what the MX Pro will do.

- **Write over USB** (Chrome, Edge or Brave): pick the keyboard when the browser asks. The app reads the whole
  keyboard, saves a backup `.vil` (Downloads and `exports/`), shows what would change, and writes only that.
  Changing macros needs the keyboard unlocked: hold the two highlighted keys when asked. It then reads
  everything back to check. Close Vial or vial.rocks first.
- **Download .vil file**: load it in Vial with File, then Load saved layout.

No flashing is involved; Vial keymaps take effect at once.

Five things to know about writing over USB:

- **The keymap is stored in the half the USB cable is in.** The other half only reports its keys through the
  link cable. If you sometimes plug the cable into the other half, write to that half too.
- **An unlock cannot be called off.** If you cancel while the app asks you to hold the two keys, the keyboard
  keeps waiting and ignores Vial commands (typing still works). Unplug it and plug it back in. The app
  notices this state and says so; it does not write anything.
- **One program at a time.** Every program that has the keyboard open receives every answer. The app checks
  that each answer fits its question and stops if not, but Vial and vial.rocks do not, so close them first.
- **No backup, no write.** The app writes only after the server has saved the backup `.vil` to the `exports`
  folder. A second copy goes to your Downloads folder.
- **Macros are switched off while they are written.** The firmware runs no macro while the last byte of its
  macro memory is not zero, and the app uses that the way VIA does. If the cable comes out during the write,
  the macros stay off until the next write finishes. Keys are not affected. The keyboard is locked again
  after every write, and the app checks that the lock took.

## What is plugged in

The badge next to the keyboard names shows it for the keyboard you selected: two small halves (L and R) and a
few words. Click it for the details of both keyboards.

| Shows | Means |
| --- | --- |
| a green half | that half is plugged in and running |
| a yellow half | that half is in bootloader mode (a drive is showing) |
| dashed halves | something is plugged in, but the app does not know which half yet |
| grey halves | nothing on USB |

**Corne Choc Pro BT.** Both halves show up on USB on their own. The left half announces the keyboard's name
and the right half announces none, which is how the app tells them apart; in bootloader mode it reads the
firmware on the drive instead. This shows the cable only. A keyboard working over Bluetooth with no cable
reads "Not connected by USB".

**Corne MX Pro.** You plug the cable into one half only; the other half works through the link cable.
Both halves announce the same name, so the app has to be told once which is which: plug the cable into the
left half and click "This is the left half". Do the same for the right half if you ever plug that one in.
How the app remembers depends on the firmware that is on the keyboard:

- **It gives a serial number.** Checked on a real keyboard in November 2026: it announces itself as
  "My Corne MX" with the serial number of its chip, and each half has its own chip. The app keeps the serial
  number and the side in `settings.json`. Nothing is written to the keyboard, the browser does not ask for
  anything, and from then on the half shows up by itself.
- **It gives no serial number.** The app stores one hidden keycode on that half instead: layer 16, matrix
  position row 3, column 0, which has no switch, so it cannot be pressed, and Vial neither shows nor saves it.
  Your keys do not change. A firmware reset or reflash removes the mark. To read it, click
  "Check which half" once per plug-in and pick the keyboard in the browser's prompt.

Keebart's firmware builds do not agree on the USB name or product id ("Corne MX Pro", id 4 in the source;
"My Corne MX", id 0 on the keyboard that was checked). The indicator accepts both. Before anything is written,
the app asks the keyboard for its Vial id, which is the same in both.

The list of USB devices comes from macOS (`ioreg`). On Linux and Windows the app still finds bootloader
drives, and the MX Pro through the browser, but not a running ZMK half.

How ZMK things are carried over:

| ZMK | On the Vial keyboard |
| --- | --- |
| `&kp`, with modifiers | the same key (`LS(LG(X))` becomes `SGUI(KC_X)`) |
| hold-tap with a modifier and a plain key, `&mt` | mod-tap (`LSFT_T(KC_A)`) |
| hold-tap with a layer and a plain key, `&lt` | layer-tap (`LT1(KC_TAB)`) |
| any other hold-tap, tap dance | a Vial tap dance |
| `&sk`, sticky key | one-shot modifier (`OSM(MOD_LSFT)`) |
| `&mo`, `&to`, `&tog`, `&sl` | `MO`, `TO`, `TG`, `OSL` |
| `&caps_word`, `&key_repeat`, `&bootloader`, `&sys_reset` | `QK_CAPS_WORD_TOGGLE`, `QK_REPEAT_KEY`, `QK_BOOT`, `QK_REBOOT` |
| macros | Vial macros (`M0`, `M1`, …) |
| combos | Vial combos, matched by keycode on the combo's first layer |
| mod-morph between two plain keys | a key override |
| `&rgb_ug` | `RGB_TOG`, `RGB_MOD`, … (fixed colours have no key in Vial) |
| encoders (`&inc_dec_kp`) | the encoder map |
| `&bt`, `&out`, backlight | nothing: the key is left empty and listed |

Things to know:

- QMK has one set of tap-hold timings for the whole keyboard. They are taken from the hold-tap you use most
  and listed under "Tap-hold timings", where you can switch them off one by one.
- ZMK's `hold-trigger-key-positions` has no match unless it means "the other hand" (QMK's chordal hold).
- A key that has no equivalent can be given its own Vial keycode: click it in the Vial view and tick
  "Use a different Vial keycode on this keyboard only". These choices are stored next to the keymap as
  `config/<keyboard>.vial.json` when you save.
- The app only writes to a keyboard whose Vial id matches the Keebart Corne MX Pro.

To update Keebart's firmware itself (rarely needed): hold Q (left half) or P (right half) while plugging that
half in, or hold BOOT and tap RESET on the underside. A drive named RPI-RP2 appears. Copy the same `.uf2`
to each half.

## What has and has not been tested

Tested here: reading and writing your keymap byte for byte, the translation of every key in it, the `.vil`
file shape, and the USB writer against a simulated keyboard that follows the firmware source
(`npm test`, 33 tests). The export was also checked name by name against the list of names Vial's loader accepts.
The left/right detection was run on the twelve firmware files of your build, and the flash checks against a
pretend bootloader drive.

Read from a real Corne MX Pro (read requests only): its Vial id, its 16 layers, its two unlock keys and its
layout definition are the same as the ones the app uses, key position by key position.

Not tested: a write to a real Corne MX Pro. The first write is the real test, which is why the
app always saves a backup first. Also not tested on the real keyboards: the USB names the Corne Choc Pro
halves announce (taken from the firmware files), and whether Keebart's bootloader offers `CURRENT.UF2`.
If it does not, the app says it cannot tell which half is on the drive and asks you to check.

## Where things are

```
server.mjs            local server: files, git, GitHub builds, UF2 copy (listens on this computer only)
lib/usb.mjs           the macOS USB list, and which half a firmware image is for
public/               the editor (plain JavaScript modules, no build step)
public/js/core/       keymap reader/writer, ZMK-to-Vial translation, .vil export, Vial USB protocol,
                      what is plugged in (connection.js, watch.js)
public/data/          key tables and the Corne MX Pro definition
keymaps/bundled/      the copy of your keymap the app starts with
test/                 tests and the simulated keyboard
tools/gen-data.mjs    regenerates public/data from the ZMK, vial-gui and Keebart sources
settings.json, repos/, firmware/, exports/   created as you use the app
```

## Credits and licences

- Key names from [ZMK](https://github.com/zmkfirmware/zmk) (MIT).
- QMK/Vial keycode names and numbers from [vial-gui](https://github.com/vial-kb/vial-gui) (GPL-2.0-or-later);
  protocol details from vial-gui and [vial-qmk](https://github.com/vial-kb/vial-qmk).
- Corne MX Pro definition from [Keebart's vial-qmk fork](https://github.com/Keebart/vial-qmk-keebart).
- The idea, and the keymap formatting it stays compatible with, from
  [nickcoutsos/keymap-editor](https://github.com/nickcoutsos/keymap-editor).
- Fonts: Barlow, Barlow Semi Condensed and IBM Plex Mono (SIL Open Font License 1.1).

Because it includes tables derived from vial-gui, this app is under GPL-2.0-or-later.
