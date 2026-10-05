# SMS Game Designer

A no-code environment for making Sega Master System games: Blockly for logic,
pixel editors for art, a compiler running as WASM, and an emulator to play
the result. Everything happens in the browser — no server, no accounts, no
install.

Ported from [`vcs-game-maker`](https://github.com/haroldo-ok/vcs-game-maker),
built on [CVBasic](https://github.com/nanochess/CVBasic) and
[gasm80](https://github.com/nanochess/gasm80), with the browser toolchain
from
[`CVBasic-emscripten`](https://github.com/haroldo-ok/CVBasic-emscripten).

## The idea

The Atari 2600 has five movable objects, so `vcs-game-maker` can name them
all: `player0`, `player1`, `missile0`, `missile1`, `ball`. The Master System
has 64 sprites, and a modest shmup has 25 things on screen at once. Naming
them is hopeless.

So this tool changes the unit of authoring:

> You author **types** — a Ship, a Bug, a Shot. The runtime owns the
> individual copies. Interactions are declared between **groups**, not
> between individuals.

Everything else follows from that. Scripts are written from the point of view
of one instance, so blocks say *set my x* and never name anything. Collision
is `on collide with enemy` on a type, and the tool derives the matrix — four
specialised tests for the worked shmup, not the 300 a named-object model
would need. Bullets and explosions can come and go, because lifetime finally
has somewhere to live.

## Why this backend

Everything must run in the browser, so the real question is not "which
console" but "which compiler can ship as a WASM blob, and which emulator can
ship next to it". CVBasic and gasm80 are two small, portable, file-in
file-out C programs — the same property that makes this kind of tool possible
at all. And the Master System needs no BIOS, so Play is one fetch lighter and
one caveat shorter than the alternatives.

The same project also builds for the SG-1000 — genuinely the same project,
with the instance counts brought inside the smaller machine and one line
changed. `examples/shmup-sg1000.json` is the worked shmup on a TMS9918: half
the pool, one 16x16 hardware sprite per actor instead of two 8x16 ones, one
colour per sprite instead of per pixel, and not a single change to any actor,
script or collision rule.

ColecoVision and MSX share that renderer and should be close. They are not
tested, so the roadmap says so.

## Getting started

```sh
npm install
npm run serve         # the compilers are already in public/wasm
```

The in-browser compilers ship prebuilt in `public/wasm/`. To rebuild them,
you need Zig, which installs from PyPI - no Emscripten SDK:

```sh
pip install ziglang==0.16.0
npm run wasm          # make -C toolchain wasm
```

To work headlessly — no browser, no WASM — you only need the native tools:

```sh
make -C toolchain native        # builds ./bin/cvbasic and ./bin/gasm80
npm run sample                  # writes examples/shmup.json
npm run rom                     # project JSON -> .bas -> .asm -> .sms
npm test                        # the whole suite: codegen, blocks, UI, playtests,
                                # and an end-to-end walk through the built editor
```

`npm test` also runs the block layer headlessly: Blockly works fine without a
DOM as long as nothing is injected into a page, so the tests build real block
trees, lower them, and compile the result to a ROM.

The suite does not stop at "it compiled". `tools/sms.py` is a headless
Master System — a real Z80 core plus enough VDP to render a frame — and
`tools/playtest.py` runs the built ROM on it and checks what a player would
notice: that the cast is on screen, that the pad moves the ship, that holding
fire spawns shots, that clearing a wave advances the room.

```sh
pip install z80 pillow
python3 tools/sms.py out/shmup.sms --frames 40 --png out/frame.png
python3 tools/playtest.py out/shmup.sms out/shmup.sym
```

That exists because the shmup once compiled cleanly, reported 91% of a frame,
passed every source-level test, and drew its entire cast as thin vertical
slivers.

`npm run rom` prints the whole accounting:

```
  out/shmup.bas  (705 lines)
  27 slots, 16/96 sprite defs, 42 collision checks/frame
  Frame 91% at worst case (sprites 34%, behaviours 24%, collision 31%)
  RAM 509/7966 bytes (6%)
  ROM out/shmup.sms  32768 bytes
```

## Layout

```
engine/          the CVBasic kernel, hand-written and versioned
  core.bas         entity pool and declarations (no executable code)
  kernel.bas       movement, animation, reaping, rendering
  terrain.bas      tile collision (only included when a room has a tilemap)

src/ir/          project model -> intermediate representation
  schema.js        project shape, target profiles, migration
  build-ir.js      slot ranges, collision matrix, VRAM and RAM planning
  lint.js          rules that run on every edit
  budget.js        frame budget, from measured cycle counts

src/generators/  IR -> CVBasic text
  blockly-lower.js          blocks -> statement AST
  cvbasic/emit-program.js   assembly and emission order
  cvbasic/emit-*.js         actors, collision, behaviours, rooms, assets

src/blocks/      Blockly definitions and the scoped toolboxes
src/components/  actor editor, sprite editor, Blockly host, budget meter
src/views/       Game / Actors / Rooms / Play / Code
src/workers/     the compiler Worker
examples/        a shmup, a platformer, an SG-1000 cut of the shmup, and a
                 coverage sample that uses every block in the language
tools/           headless build, sample generators, tests
  sms.py           a headless Master System, for looking at the screen
  playtest.py      runs the ROM and asserts what a player would see
  cycles.py        static Z80 cycle counter, for the frame budget
docs/            measurements and porting notes
```

## Budgets, not surprises

On this hardware the limits *are* the design, so they are visible while you
edit rather than after you wonder why the game crawls:

```
 Sprites  ████████░░  22/64 hw      RAM    ██░░░░░░░░   509/7966 B
 VRAM     ██░░░░░░░░  16/96 defs    ROM    ██████████  32.0/32 KB
 Slots    ███████░░░  27/40         Frame  █████████░  91%
```

Everything except ROM size comes from the IR with no compile. RAM comes
straight out of CVBasic, which prints its own accounting on every build. The
frame figure comes from cycle counts measured on the real generated Z80 —
see [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md).

The same idea applies beyond performance. A platformer actor reports what its
jump actually reaches, because nobody can eyeball that from "jump strength
5":

```
 note  Hero jumps 33 px (4 tiles) and covers 54 px (6 tiles) in the air.
       Keep ledges within 3 tiles of each other.
```

When something is over budget the tool says what to do about it, with a
button that does it: *"enemy vs player_shot is 48 checks a frame. Checking it
every other frame halves that, and at these speeds it is not noticeable."* A
user cannot act on a number alone.

## Examples

**Open → Examples** in the editor offers three working games: *Bug Blaster*
(a shooter), *Cavern Run* (a platformer with tile terrain) and *Bug Blaster
SG* (the same shooter on the SG-1000). Their scripts open as real blocks you
can read and change. They are the same files the test suite builds and plays
on emulated hardware, so anything offered is known to work.

## What you get without doing anything

A new project already has the parts that make something feel like a game
rather than a demo: a title screen that waits for the button, a game over
that returns to it, five sound effects, and three tunes. Music takes two of
the four sound channels and effects take the other two, so they never cut
each other off.

None of it needs a tracker or an envelope editor. All of it is plain,
commented CVBasic in the exported source.

## Escape hatches

- **Export the ROM** and run it on real hardware or any emulator.
- **Export CVBasic source + engine** as a zip that builds standalone. The
  generated code is commented and meant to be read; that is the answer to
  every "can it also do X".
- **Export a playable HTML bundle** — ROM plus emulator plus a page.

## Credits

`vcs-game-maker` by haroldo-ok, with contributions by AbstractPolygon.
CVBasic and gasm80 by Óscar Toledo G. (nanochess). EmulatorJS for the player.
Blockly by Google.

## Licence

MIT, matching the projects it is derived from.
