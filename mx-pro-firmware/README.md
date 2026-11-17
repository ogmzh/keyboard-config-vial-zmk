# Corne MX Pro firmware

The firmware of the wired Corne MX Pro: what it shipped with, what it runs now, and how to change it.

| File | What it is |
| --- | --- |
| `shipped/shipped_left.uf2`, `shipped/shipped_right.uf2` | The firmware the keyboard came with, saved from each half on 2026-11-17. Each file is the whole 16 MB chip. |
| `custom/corne_mx_pro_vial_custom.uf2` | The firmware the keyboard runs now. The same file goes on both halves. |
| `custom/vial_custom.patch` | The source change, against [Keebart/vial-qmk-keebart](https://github.com/Keebart/vial-qmk-keebart), branch `vial`, commit `63e2d624`. GPL-2.0-or-later, as the source it changes. |

## What the custom firmware changes

- **Layer keys.** A layer-tap key takes its layer as soon as another key is pressed. Stock Vial has one tap-hold
  timing for the whole keyboard, so the layer keys waited as long as the home-row mods.
- **A macro key that changes with a modifier.** A macro key can run a second macro while Shift (held, sticky, or
  caps word) is active. The app writes the pair as a key override. This is what makes Shift + ć give Ć.
- **USB serial number.** Each half gives its chip id, so the app can tell the halves apart.

## What the shipped firmware is

It is not a build of Keebart's public source. It is about 300 KB against 79 KB, and it has storage of its own
(the name "My Corne MX", layer names). It looks like the firmware for Keebart Studio. The custom firmware does
not have that part. Keebart offers no ready-made firmware file, so the two files in `shipped/` are the way back.

## Flash, or go back

You need [picotool](https://github.com/raspberrypi/picotool) (`brew install picotool`).

1. Disconnect the cable between the halves.
2. Hold **Q** (left half) or **P** (right half) while you plug that half in. The half is now in bootloader mode
   and shows up as a drive named `RPI-RP2`. This also erases the settings stored on that half.
3. Write the file and let picotool check it:
   ```
   picotool load -v -x custom/corne_mx_pro_vial_custom.uf2
   ```
   To go back, use `shipped/shipped_left.uf2` on the left half and `shipped/shipped_right.uf2` on the right.
4. Do the other half. Flash both before you use the keyboard.
5. Connect the halves, plug the cable into the left half, and click **Write over USB** in the app. A new
   firmware starts with the default keymap.

Things that were learned the hard way:

- **Do not copy the file onto the `RPI-RP2` drive.** On macOS 26.6 the copy hung for ten minutes and wrote
  nothing. picotool writes to the chip directly.
- **This keyboard has a closed case.** There are no holes for the BOOT and RESET buttons. Q and P are part of
  the firmware, so a firmware that does not start can only be replaced after the case is opened. Holding P was
  checked on the custom firmware: it works.
- **Save before you change.** `picotool save -a -v <file>.uf2` saves the whole chip of the half that is in
  bootloader mode.

## Build it

In Docker, with the source folder mounted and no network:

```
git clone -b vial https://github.com/Keebart/vial-qmk-keebart.git && cd vial-qmk-keebart
git checkout 63e2d624 && git apply ../custom/vial_custom.patch
docker run --rm --network none -v "$PWD":/qmk_firmware -w /qmk_firmware \
  ghcr.io/qmk/qmk_cli@sha256:2dc05fc9f32efebd6b05c2b8676ee548358bc7e151e9dbf4dac6b6eed4513b07 \
  sh -c 'git config --global --add safe.directory /qmk_firmware && qmk compile -kb keebart/corne_mx_pro/standard -km vial_custom'
```

Tests, in the same container: `make test:vial_custom_layer_tap` (22 cases) and
`make test:vial_custom_macro_morph` (11 cases).

Known limits: with caps word on, a held Shift still gives the capital; a mod-tap that is not settled yet does
not count as Shift; macro keys sent by combos, tap dances or the repeat key do not change with the modifier.

## Checksums (SHA-256)

```
20efe9035d91d0a1904398786561812df2ee1022d3539e8cae18f983ca411662  shipped/shipped_left.uf2
5922fee7b0e7168e47e3981c20385daff0bd248801d01ddb36d61d1edb3390ea  shipped/shipped_right.uf2
91a3ee6e3b7eeff5cab284d437e7e3eff6dbc158dc5e0cb328d33eb23d9d40c3  custom/corne_mx_pro_vial_custom.uf2
```
