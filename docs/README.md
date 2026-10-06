# SMS Game Designer — editor

A production build of the editor. Static files only: there is no server
component, and nothing you make is uploaded anywhere.

*Formerly "SMS Game Maker". Projects and autosaves from before the rename
open as they are — the first launch carries your autosave across, and
`.smsgm` files still open alongside the new `.smsgd`.*

## Running it

Serve the folder over HTTP — any static server will do:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

It has to be HTTP rather than a `file://` URL, because the compiler runs in
a Web Worker and browsers will not start one from a file. The build uses
relative paths throughout, so it works from a subdirectory, a static host,
or an itch.io page.

## Building and playing a game

Press **Play**. The editor compiles your project to a ROM right there in the
browser, usually in well under a second, and runs it. **Download ROM** on the
Play tab gives you the cartridge image to keep, share, run in any emulator,
or put on real hardware.

Everything happens inside this folder. The compilers - CVBasic and gasm80,
built to WebAssembly - are in `wasm/`, and the ROMs they produce are
byte-identical to the native compilers'. The emulator is EmulatorJS 4.2.3,
trimmed to its Master System core, in `emulator/`. Pressing Play makes no
request to anywhere but the server you are serving this folder from, so it
works offline.

In-editor play covers the Master System and the SG-1000. ColecoVision and MSX
games build, and the Play tab tells you to download the ROM to run them.

EmulatorJS and its cores are GPL-3.0; the licence is in
`emulator/LICENSE-EmulatorJS`.

## Start with an example

**Open → Examples** loads one of three working games: a shooter, a
platformer with painted terrain, and the shooter again on the SG-1000. Their
scripts open as real blocks. Opening one replaces the project you have open;
the editor asks first if there is anything to lose.

## Painting rooms

In **Rooms → Paint tiles**, pick a tile and drag across the room to paint;
right-drag to erase. The pixel editor under the palette draws the selected
tile, and its flags decide what the tile *is* — Solid is what the movement
behaviours obey, the rest are for your own scripts to test. **Place actors**
puts the chosen actor where you click; right-click one to remove it.

## Your work is yours

Projects autosave in your browser, and **Save** downloads the whole project
as a single `.smsgd` file. Nothing you make leaves your machine, and neither
does anything the editor does.

## Source maps

`.js.map` files are included so the code is debuggable in place. Delete them
if you would rather not ship them; the editor does not need them.
