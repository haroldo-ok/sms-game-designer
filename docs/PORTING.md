# Porting notes

What carried over from `vcs-game-maker`, what had to change, and why.

## The one decision everything else follows from

On the Atari 2600 the number of things on screen and the number of things the
user authors are the same number, and it is five. `vcs-game-maker` can
therefore use a fixed, named-object model: `player0`, `player1`, `missile0`,
`missile1`, `ball`, plus the playfield. Every block names its object
explicitly, and collision is a handful of `collision(a,b)` blocks because the
hardware gives you exactly ten pairs.

The SMS VDP has 64 sprites. A modest shmup has one player, four player
bullets, twelve enemies and eight enemy bullets. Nobody is going to wire 25
objects and 300 collision pairs by hand.

So the port keeps the *shape* of `vcs-game-maker` — Blockly for logic, pixel
editors for art, a compiler in WASM, an emulator for Play, all client-side —
and changes the unit of authoring:

> Author **types**. The runtime owns **instances**. Interactions are declared
> between **groups**, not between individuals.

| | `vcs-game-maker` | this |
|---|---|---|
| Unit of authoring | hardware object | actor type |
| Instance count | fixed at 5 | 0..N per type, pooled |
| Script scope | one global program | one small script per type per event |
| Object reference | by name | `me`, `other`, `the player` |
| Collision | per named pair | per group pair, derived |
| Common logic | copy-paste | behaviours |
| Resource limits | implicit | explicit, per-room budget meter |
| Backend | batari Basic | CVBasic + gasm80 |

## What carried over

- **Vue 2 + Vuetify + Blockly.** Same stack, same `raw-loader` trick for
  bundling non-JS assets as text, same "everything in the browser" premise.
- **The compile-in-WASM pipeline**, from `CVBasic-emscripten`, which had
  already done the hard part.
- **The eject button.** `vcs-game-maker` exports batari Basic; this exports
  CVBasic plus the engine, so it builds standalone.
- **Playable HTML bundle export**, which is what makes the output shareable.

## What had to be rebuilt

### One project document instead of a dozen storage keys

`vcs-game-maker` keeps a separate `localStorage` key per editor tab
(`usePlayer0Storage`, `useBackgroundsStorage`, and so on). That works when
the tabs are fixed. Once a user can create an unbounded number of actor
types, there is no fixed set of keys to have — and migration becomes twelve
functions instead of one. `src/hooks/project.js` holds one versioned
document; `migrate()` in `src/ir/schema.js` is the only place that knows how
schemas change.

### An IR between the blocks and the text

`vcs-game-maker` generates batari Basic straight from blocks with Handlebars
templates. Fine at VCS scale. Here an intermediate representation earns its
keep four times over:

1. **Whole-program decisions.** Slot allocation, collision-pair selection,
   sprite-definition numbering and RAM layout are global. You cannot decide
   them while walking one block tree.
2. **A second backend.** A Genesis emitter reads the same AST. If blocks
   emitted text directly, a second target would mean rewriting every block.
3. **Testability.** IR to text is a pure function. `tools/test.mjs` exercises
   the whole generator in Node with no browser, no WASM and no emulator.
4. **Live budgets.** "This room needs 71 sprite definitions and the budget is
   96" is an IR query, answerable while the user edits.

Width inference lives at the IR level, which is what keeps generated code out
of CVBasic's `score` versus `#score` trap. The user never sees a `#`.

### A hand-written engine kernel

The generated program is *engine + tables + user scripts*, not a literal
translation of blocks. `engine/` is hand-written CVBasic, versioned
separately, `INCLUDE`d into the generated file. It is the code that runs
sixty times a second over every entity, so it is where all the performance
is and it is worth tuning once for everybody.

Keeping it as real include files rather than concatenating means kernel line
numbers stay stable, the kernel can be developed and tested outside the tool,
and a compiler error inside it is recognisable as a tool bug rather than a
user one.

### Behaviours

Most beginner scripts are the same six programs. Shipping them as configured
components instead of blocks does two things: a working shmup takes ten
minutes and zero blocks, and the generated code stays small — a behaviour is
about ten lines of engine-quality CVBasic where the literal translation of
the equivalent blocks is about forty. ROM size is the constraint that decides
whether a game fits in 32 KB.

### Scoped toolboxes

Blocks that need `me` do not exist in the global workspaces. Blocks that need
`other` only exist inside a collide event. That removes a class of confusing
errors instead of diagnosing them: there is no "you can't use this here"
message, because there is nothing to drag.

## Changes to the toolchain integration

`CVBasic-emscripten` builds the two compilers with Emscripten and reloads a
hidden `<iframe>` per invocation, because - in its own words - *"neither
cvbasic nor gasm80 clean their internal variables between runs"*. That is
correct and it works. This port keeps the idea and changes the machinery.

**Zig and WASI instead of Emscripten.** Both compilers are plain C programs
that read and write files. Zig ships a complete clang with a WASI libc, and
Zig is on PyPI, so `pip install ziglang` and `make -C toolchain wasm` produce
`cvbasic.wasm` and `gasm80.wasm` - 213 KB and 67 KB - with no SDK to install.
They are ordinary WASI programs: no generated JavaScript glue, no embedded
filesystem image. The editor runs them through `@bjorn3/browser_wasi_shim`, a
small JavaScript WASI runtime, against a filesystem made of `Uint8Array`s.

The ROMs they produce are byte-identical to the native compilers' for every
sample, and `tools/test-wasm.mjs` checks that on every run - through the same
three modules the editor uses, not a lookalike.

**A fresh instance instead of a fresh iframe.** Each build instantiates a new
`WebAssembly.Instance` from a module compiled once, which gives every run its
own linear memory - the same clean-globals guarantee as the iframe, without
the DOM round trip. A test builds A, then B, then A again and requires the two
A's to match.

**A Worker, with the page as a fallback.** Builds run in a dedicated Worker so
the editor never stalls, and the ROM comes back as a transferable buffer.
Where Workers are unavailable the page runs the same code directly - which is
also what lets the end-to-end test press Play in jsdom and compare the ROM it
gets with the native build's, byte for byte.

**Engine sources passed in, not baked in.** The engine changes far more often
than the compiler does; a kernel tweak should not need a toolchain rebuild.
The engine is bundled with the editor and written into the in-memory
filesystem for each build. The prologue and epilogue `.asm` files ship beside
the `.wasm`, because those genuinely belong to the compiler.

## Errors that mean something

`ERROR: at line 412: Bad syntax` is useless to a no-code user. The chain back
to the block is cheap and it already exists end to end:

```
block id  →  .bas line      (the ' @blk: comment codegen emits)
          →  .asm line      (CVBasic copies each source line in as a comment)
          →  ROM address    (gasm80's -l listing)
          →  live PC / RAM  (the emulator)
```

So a compiler error highlights the block that produced it; an error with no
`@blk:` marker above it is, by construction, inside the engine — a tool bug,
reported as one, with a one-click copy of the generated source. The same
chain gives PC-sampled profiling attributed to individual scripts, and lets
the editor read the entity pool out of emulator RAM to draw hitboxes over the
running game.

## Corrections to the design documents

The documents were written before anything was compiled. Six things turned
out differently; all are detailed in [MEASUREMENTS.md](MEASUREMENTS.md).

1. **The AABB wrap test in doc 03 does not work as written.** Inline in the
   `IF`, CVBasic promotes the intermediate to 16 bits and the wrap never
   happens, silently missing about half of all real overlaps. It has to be
   stored to a byte first.
2. **The renderer as designed spends 90% of a frame on multiplication.**
   `fbase + frame * fstep` compiles to a call into CVBasic's 16-bit multiply
   routine, once per visible entity per frame. Replaced with a flat frame
   table and a cached per-entity value: 2.4× faster.
3. **`CONST` without `#` is 8-bit and truncates silently.** `CONST
   MAP_CELLS = 896` allocates 128 bytes and corrupts whatever follows.
4. **The SMS sprite budget is 96 definitions, not 128.** `DEFINE SPRITE`
   accepts more than fit; definition 96 overwrites the name table.
5. **`VPEEK` does work on SMS**, contrary to doc 03 — but it is slow enough
   that the document's conclusion (keep a RAM shadow) is still right.
6. **Sprite flicker exists on the SMS and is on by default**, contrary to
   doc 03 — and the way round it is not the obvious one. The flicker path
   permutes the 64 attribute slots, which destroys a `$d0` list terminator;
   the non-flicker path has a bug that fills the X/pattern table from the Y
   table. The engine uses neither: it parks unused sprites instead of
   terminating, which makes the permutation harmless.
7. **`count of <group>` is cheap, not expensive.** Doc 02 lists it among the
   "explicit, obviously-expensive" blocks to be shown in the profiler. It
   does not have to scan the pool: spawn increments a per-group counter and
   reap decrements it, so the block is a single array read. That matters
   because "are all the enemies dead" is checked every frame of every game
   anyone will make, so a pool scan would have been the most-executed loop in
   the program.
8. **The collision estimate held.** 267–369 cycles per test against an
   estimate of 250–450, so roughly 56 tests in a quarter-frame against an
   estimated 35–60.

The worked shmup from doc 02 lands at 91% of an NTSC frame at worst case —
but only after two deliberate choices the budget meter prompts for. Without
them it is 125%, and the design documents had no way to know that.

## Where the roadmap stands

| Milestone | Status |
|---|---|
| M0 — prove the toolchain | Done before this port started, by `CVBasic-emscripten` |
| M1 — kernel by hand, measured | **Done.** `engine/`, `docs/MEASUREMENTS.md` |
| M2 — codegen from JSON | **Done.** `tools/build.mjs`, `examples/shmup.json` |
| M3 — editor: actors, blocks, one room | **Done.** Builds ROMs in the browser, byte-identical to the native compilers |
| M4 — rooms, tilemaps, terrain | **Done and playtested**, with a tile editor, drag painting, and an end-to-end test of the room editor |
| M5 — sound, music, title flow | **Done and playtested.** Effects, three built-in tunes, title screen |
| M6 — second target | **SG-1000, ColecoVision and MSX build, run and are playtested**, shooter and platformer both |
| M7 — authored sound | **Done and playtested.** Effect and tune editors, preview, per-chip effect players |

Sound is built in rather than authored: five effect envelopes played a step
per frame, and three tunes — a title loop, something under the action, and a
sting when you lose. `PLAY SIMPLE NO DRUMS` takes two of the four channels,
leaving exactly the tone and noise channels the effect player uses, so music
and effects never cut each other off. A beginner needs a shot, a pickup and
an explosion long before they need an envelope editor, and a game with no
music feels dead.

Tunes are written as space-separated tokens in CVBasic's own note notation,
so the generated source stays readable and anyone who outgrows the three
built-ins can edit it by hand.

### Authored sound (M7)

The Sound tab is that long-term answer, kept small. An effect is a list of
`{hz, vol}` steps, one a frame; a tune is two voices of the same tokens the
built-ins use, edited on a piano roll. Both are stored in the project
(`sounds`, `music`) and described in one place, `src/ir/sound.js`, which the
generator, the lint, the blocks and the browser preview all read.

Three things came out of building it that a reading of the old code would
not have shown:

- **Every built-in bass line was silent.** The SN76489's divider is ten
  bits, so it cannot play below about 110 Hz, and CVBasic's player mutes a
  note whose divider does not fit. The bass instrument plays an octave down,
  and every bass note asked for something below the chip's range. The
  playtest counted PSG writes, and "silent" is a write. The lines are now
  an octave up, the playtest listens for a volume above silence on each
  voice, and the lint warns about an authored note the target cannot sound.
- **The game over sting never played.** It was played only if some block
  elsewhere named it, and none did. It is now a title-screen setting.
- **Effects were silent on the MSX.** The effect player wrote to SN76489
  channels the AY-3-8910 does not have. `engine/sfx_ay.bas` is the same
  player for the AY, on channel C, reading the same table - the two chips
  divide the same clock, so the data needs no translation.

Every game now boots to a title screen and returns to it after a game over,
so losing lands somewhere deliberate instead of dropping you straight back
into play.

## The second target, and what it proved

`examples/shmup-sg1000.json` is the same game on a TMS9918 machine, and it
builds, runs and passes a playtest. It is the same project file: the same
actors, the same collision matrix, the same behaviours and the same scripts.
Only two things differ, and both are data rather than code — the instance
counts, and `target: 'sg1000'`.

That is the claim the whole target-profile idea rested on, and it held. What
it cost:

- **The renderer split in two.** `engine/kernel.bas` lost `k_render` to
  `engine/render_sms.bas` and `engine/render_tms.bas`, and the generator
  includes one of them. Nothing else in the engine moved: the pool, both
  movers, animation, reaping, terrain and sound are shared verbatim.
- **The asset emitter learned a second format.** A TMS9918 sprite is 16x16
  with one colour for all its pixels, so art becomes a one-bit mask and the
  colour moves to a per-animation table.
- **Frame numbers changed units.** The SMS counts 8x8 blocks in twos; the
  TMS counts whole 16x16 definitions in fours. That is one expression in the
  IR, because the renderer reads a ready-made number rather than deriving it.
- **The init sequence branched.** `MODE 2` and no palette load.

Roughly 150 lines across four files. The parts that did not need touching —
slot allocation, the collision matrix, budgets, lint, the statement AST, the
block language — are the parts the IR exists for.

One thing it caught that a reading would not have: **colour indices are not
portable**. A pixel value of 5 means "entry 5 of the palette this project
loaded" on the SMS and "light blue" on a TMS9918, which has a fixed palette
and nothing to load. Passing the index through painted the enemies blue, and
painted the white ship *black* — which on a black background meant it simply
was not there. The dominant art colour is now matched to the nearest fixed
TMS colour by RGB distance, and a playtest asserts no sprite is drawn in
colour 0, which is transparent.

ColecoVision and MSX share the TMS renderer, and are no longer a "should
be". `tools/sms.py` grew a headless ColecoVision and a headless MSX - the
same Z80 and the same VDP behind different ports, with a stand-in BIOS of a
few dozen bytes each, since a CVBasic program asks its BIOS for very little
- and the suite builds the shooter and the platformer for both and plays
them. Both passed the shooter's playtest unchanged once they could be run,
apart from the MSX's silent effects (above).

The platformer needed real work, because painted rooms had only ever been
emitted for the Master System:

- **Name tables are one byte a cell** on a TMS9918, not two.
- **Tiles are one bit a pixel plus a colour table.** A game with terrain
  uses `MODE 0`, where each row of a tile has its own two colours;
  `src/ir/tms.js` keeps the two a row uses most and the editor previews
  the result.
- **The collision shadow does not fit.** 768 bytes of `map_attr` is nearly
  all the RAM an SG-1000 or a ColecoVision has. Nothing writes to it while a
  room runs, so `engine/terrain_rom.bas` reads the room's table from the
  cartridge through a pointer instead. Same procedures, same cost a lookup.

What is still missing for these two is an emulator in the editor: their
games build and export, and the Play tab says to download the ROM.
