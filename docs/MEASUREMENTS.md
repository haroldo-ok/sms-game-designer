# Measurements

The design documents size everything around one number they could not know:
how much of a frame the engine actually costs. `07-toolchain-integration.md`
puts it plainly — *"the remaining unknown that matters most, and that no
existing code answers"* — and estimates 35 to 60 collision tests per frame.

This document replaces the estimates with measurements. Everything below was
counted from the real generated Z80, using `tools/cycles.py` against
`out/shmup.asm`, built from `examples/shmup.json` — the worked shmup from
`02-actor-model.md`, as a real project.

A static count is the right instrument here. The collision inner loop, the
render loop and the movers are straight-line code, and on the Z80 the only
instructions whose timing depends on data are conditional returns and the
block instructions, neither of which CVBasic emits in these paths. `JP cc,nn`
costs 10 T-states whether or not it is taken.

Reference frame: **59,736 cycles** (NTSC, 3.579545 MHz ÷ 59.92 Hz). PAL gives
about 20% more.

## Collision

Per candidate pair, including the loop tail:

| Path | Cycles | % frame |
|---|---|---|
| Slot empty, rejected at `e_type` | 165 | 0.28 |
| Active, rejected on Y | 267 | 0.45 |
| Active, passed Y, rejected on X | 369 | 0.62 |
| Outer loop, per active entity (hoisted setup) | 272 | 0.46 |
| Outer loop, per empty slot | 110 | 0.18 |

**The estimate held.** `03-runtime-engine.md` guessed 250–450 cycles for a
full two-axis test; the measurement is 267–369. At a 25% collision budget
that is **about 56 tests per frame**, against the document's 35–60.

The worked shmup has 66 candidate pairs, which the document itself calls
"already at the edge". It is: 45% of a frame. Half-rate checking on the one
expensive pair brings it to 31%.

Two things make those numbers what they are, and both were worth finding:

**Y first is worth 100 cycles a pair.** Rejecting on Y costs 267 and rejecting
on X costs 369, so testing the axis that separates most pairs first saves
roughly 100 cycles on every pair that misses. In a shmup that is nearly all
of them.

**The wrap test only compiles well if you store it.** `03-runtime-engine.md`
writes the AABB check inline:

```basic
IF (cay - e_y(cb) + 12) < 24 THEN
```

That does not work. CVBasic evaluates the subtraction in 8 bits and then
promotes to 16 before the add:

```asm
    SUB B
    LD L,A
    LD H,0        ; <- the wrap is gone
    LD DE,12
    ADD HL,DE
    LD DE,24
    OR A
    SBC HL,DE
```

The whole point of `(a - b + h) < 2h` is that the subtraction wraps, so a
difference of −8 becomes 248 and fails the range test. Once the intermediate
is 16 bits, −8 becomes 65528, `+12` is 65540, and the test rejects a pair
that genuinely overlaps. It silently misses roughly half of all real
collisions — the half where `b` is below `a`.

Storing into a byte first keeps everything in the accumulator:

```basic
ct = cay - e_y(cb)
IF ct < 24 THEN
```

```asm
    SUB B
    LD (cvb_CT),A
    CP 24
```

Correct, and about a third of the instruction count. The generator always
emits the two-statement form, and `emit-collision.js` says why.

## Rendering

Per slot, per frame:

| Path | Before | After | % frame (after) |
|---|---|---|---|
| Empty slot | 166 | 166 | 0.28 |
| 8-wide actor drawn | — | 649 | 1.09 |
| 16-wide actor drawn | ~1,985 | 820 | 1.37 |

**This is the big one.** The renderer as designed computes each entity's
sprite frame from a base and a stride:

```basic
k_f = a_fbase(k_a) + e_frame(k_i) * a_fstep(k_a)
```

`a_fstep` is a runtime table value, so CVBasic cannot know it is always 2 or
4, and emits `CALL _mul16` — a 16-iteration shift-and-add loop costing
roughly 900 cycles. Once per visible entity, every frame.

At 27 entities that is about **53,600 cycles, or 90% of an NTSC frame, spent
entirely on multiplication**. The engine could not have worked.

The fix is to stop computing it. Sprite definitions are allocated
sequentially at build time, so every frame's `f` value is known then: the
generator emits a flat `af_data` table and the kernel reads
`af_data(a_fofs(anim) + frame)`. Better still, the value only changes when
the frame changes, so it is cached in a new `e_sprf` array and the render
loop is a single array read.

A sprite definition is two 8×8 patterns, so every valid `f` is even and bit 0
is free. It carries the "this actor is 16 wide, draw a second hardware
sprite" flag, which removes the `a_wide` lookup from the loop as well.

Net: **2.4× faster rendering**, and `a_fbase`, `a_fstep` and `a_wide`
disappear from the engine entirely.

## Movement

| Path | Cycles | % frame |
|---|---|---|
| `k_move` (8.8 subpixel), stationary | 236 | 0.40 |
| `k_move`, one axis | 740 | 1.24 |
| `k_move`, both axes | 1,244 | 2.08 |
| `k_move_int` (whole pixel), both axes | 322 | 0.54 |
| Fixed direction, fixed integer speed, inlined | ~60 | 0.10 |

The 8.8 scheme in `03-runtime-engine.md` is correct and the generated code
for it is good — CVBasic turns `(#d - 128) * 16` into `ADD HL,65408` plus
four `ADD HL,HL`, so two's complement does the sign handling for free, and
`*256` and `/256` become register moves.

It is also four times more expensive than most actors need. "Move down at 2"
does not want subpixels; gravity does. So the IR decides per actor type:
anything that asks for a fractional speed (or uses the Platform behaviour)
gets `k_move` and sixteenth-pixel velocities, everything else gets
`k_move_int` and whole-pixel ones. The two encodings never meet inside a
type, because one type only ever calls one mover.

A fixed direction at a fixed integer speed does not even need that — it folds
to `e_y(self) = e_y(self) - 4`. The Shot's entire behaviour, movement and
off-screen destruction together, is **341 cycles**.

## Other findings

**No runtime math calls remain.** After the changes above, the generated
program contains zero calls to `_mul16`, `_div16` or `_mod16`. The last one
was `RANDOM(90)` in the Bug's fire chance: CVBasic compiles `RANDOM(n)` to a
modulo call for general `n` but to a single `AND n-1` for a power of two, so
the generator snaps random bounds to powers of two. "About 1 in 64" plays
identically to "1 in 90" and costs several hundred cycles less.

**Both halves of CVBasic's SMS sprite upload have a trap in them.** This one
cost two rounds of debugging and is the reason `tools/sms.py` exists.

`03-runtime-engine.md` says flicker is a TMS9918 feature and that "on SMS
there's no such thing". It is there, it is on by default, and the SMS branch
of the attribute upload in `cvbasic_prologue.asm` has two paths:

*Flicker on (the default).* The copy walks the sprite buffer seven entries at
a time — stride 7 modulo 64, which visits every slot in a scrambled order —
and applies the same stride to the Y half and the X/pattern half. It is
correct: a pure permutation of the 64 hardware sprites, invisible as long as
every slot holds valid data.

*Flicker off.* The copy is straight, but it reloads `HL` with `sprites`
instead of `sprites+$80` before the X/pattern half:

```asm
    ld hl,$3f80
    call SETWRT
    ld hl,sprites        ; should be sprites+$80
    ld bc,$8000+VDP
    outi
    jp nz,$-2
```

So the X/pattern table gets filled from the Y table. Every sprite ends up
with `pattern == x == y`, and the whole cast draws as thin vertical slivers.

The engine walked into both. It terminated its sprite list with a Y of `$d0`,
which the flicker permutation relocates every frame, chopping the list at a
random point — violent flicker while using 44 of 64 sprites. Turning flicker
off then hit the second bug.

The fix is to use neither: stay on the flicker path, and never terminate the
list. `k_render` keeps all 64 attribute entries valid, parking unused ones at
`Y=$e0` inside the invisible band, so the permutation has nothing to damage.
Only the entries used last frame and not this one need parking, which is
normally none.

Patching the prologue would have been a one-line change, and was the wrong
call: exported source has to build with stock CVBasic, or the eject button is
a lie.

**`CONST` without `#` is 8-bit and truncates silently.****`CONST` without `#` is 8-bit and truncates silently.** `CONST MAP_CELLS =
896` allocated `rb 128`. The terrain shadow would have been a fifth of its
intended size with every write past cell 127 landing in a neighbouring array
— no error, no warning, and a bug that would present as unrelated entities
corrupting each other. `CONST #MAP_CELLS = 896` is correct.

**`DIM` array sizes are limited to what the constant expresses,** which is
the same trap from the other end: an array needs a `#`-prefixed constant to
exceed 255 entries.

**The SMS sprite budget is 96 definitions, not 128.** `DEFINE SPRITE` accepts
`sprite_num` up to 127 without complaint, but the CVBasic prologue places
definition *n* at `$2000 + n*64`, and the name table starts at `$3800`.
Definition 96 is the first one that overwrites the screen.

**`VPEEK` does work on the SMS**, contrary to `03-runtime-engine.md`. It goes
through `RDVRM` with interrupts disabled, though — roughly 90 cycles a read
against about 40 for a RAM array — so the document's conclusion (keep a RAM
shadow of the collision layer) is right even though its reason is not.

## Where the worked shmup ends up

27 slots, 5 actor types, 3 collision pairs, 16 of 96 sprite definitions.

```
  RAM     509 / 7,966 bytes      6%
  ROM     32 KB
  Frame   91% at worst case
          sprites 34% · behaviours 24% · collision 31% · scripts 1%
```

Worst case means every slot of every type occupied at once, which is the
number that matters: a game that is fine until eight enemies are on screen
together is a game that stutters exactly when it should not.

It fits, but only after two deliberate choices that the budget meter is there
to prompt: a whole-pixel patrol speed instead of 0.75, and half-rate checking
on the one expensive collision pair. Without them it is 125%.

That is the tool working as intended. The limits are the design on this
hardware, and a tool that hides them just moves the discovery to the worst
possible moment.

## What the platformer found

The terrain half of the engine — the attribute shadow, `k_cell_at`, the 8.8
mover and the Platform behaviour — had been written, reviewed, shipped and
declared done without ever being compiled into a ROM. Building
`examples/platformer.json` and running it turned up four things in an hour.

**The terrain bounds guard was stale.** `k_cell_at` rejected `k_py > 223`,
which was right when rooms were 28 rows. Rooms are now authored at the
visible 24, so rows 24 to 27 indexed past the end of the shadow and returned
whatever byte happened to follow it. The limit is now a generated constant.

**The ceiling check probed one corner.** The floor check probes both bottom
corners; the ceiling probed only the top-left, so an actor could put half its
head through a ledge. It also failed to clear the sub-pixel fraction on snap,
leaving a fraction of upward momentum that could never be spent.

**Horizontal collision probed only the feet,** so an actor could walk its
head straight through an overhang. All four hitbox corners are probed now.

**`tile below me is solid` read a stale value.** The block compiles to a test
of `k_cell`, which only means anything if something just filled it — and
nothing did. It returned whatever the Platform behaviour's last probe had
left behind, so it silently reported the tile under the actor's head, or its
left foot, depending on which branch ran that frame. The `if` emitter now
emits the probe itself when the condition needs one.

**A seventh, found by playing the second room: the same mistake twice.**
Cavern 2 was written as a "mirror" of Cavern 1 but with its ledges moved by
hand, which quietly opened horizontal gaps three tiles wider than the jump
could cross. Cavern 1's failure was vertical and Cavern 2's was horizontal,
but both came from placing geometry by eye next to a number nobody had
computed. Cavern 2 is now an exact column-mirror, and the playtest walks both
rooms in both directions.

**A sixth, found by playing it: the level was unfinishable.** The jump was
correct and the level was drawn by eye, and those two facts never met. At
5 px/frame against 0.35 gravity the Hero peaks at 33 px, a little over four
tiles; the first version of the level put its lowest ledge five tiles above
the floor. Every physics test passed and the game could not be started.

Jump height is not something anyone can eyeball from "jump strength 4" - it
falls out of the launch velocity, the gravity, and the quantisation of both
into sixteenths of a pixel. So the tool computes it and says so:

```
  note   Hero jumps 33 px (4 tiles) and covers 54 px (6 tiles) in the air.
         Keep ledges within 3 tiles of each other.
```

That is the same idea as the frame budget, applied to level design: put the
number next to the decision instead of leaving it to be discovered in play.
The playtest now walks the entire climb with scripted input and insists every
ledge is reachable from the one below, which is the only test that would have
caught it.

The fifth finding was not a bug: the hero could not jump because it spawned
in a two-tile gap under a staircase and the ceiling check was correctly
refusing. Worth recording because it looked exactly like broken physics for
about twenty minutes, and the thing that settled it was being able to print
the tile grid.

## Looking at the screen

None of the above was findable from source. The shmup compiled without a
warning, reported 91% of a frame, and passed twenty-two tests while drawing
nothing recognisable.

So `tools/sms.py` is a headless Master System: a real Z80 core with enough
VDP to render a frame to a PNG or to text, and `tools/playtest.py` runs the
built ROM on it and asserts what a player would notice — that the cast is on
screen, that no sprite has `pattern == x == y`, that the pad moves the ship,
that holding fire spawns shots, that clearing a wave advances the room. It
reads the entity pool out of emulated RAM through gasm80's symbol file, the
same way the editor's live inspector does.

It is a bad emulator on purpose: no sound, no scrolling, approximate timing.
It only has to answer "is there a spaceship on the screen", which is the
question that nothing else in the pipeline was asking.

Worth recording that the harness needed debugging too. It reported that no
actor ever moved, which looked like a serious engine bug and was not: on
waking from `HALT` it advanced `PC` by one, but this Z80 core already reports
`PC` past the halt instruction. The extra byte pushed a return address into
the middle of the following `CALL`, so the first call after `WAIT` — which
happened to be `run_behaviours` — was silently skipped. A test harness gets
the same scepticism as the code under test.

## The exit code lies

Both tools can fail and still exit 0.

CVBasic returns 0 for some errors. gasm80 returns 0 for an undefined label —
**and still writes a full-size ROM**. Anything that judges a build by its
exit status therefore ships a corrupt cartridge with no warning at all:

```
$ gasm80 a.asm -o a.sms -sms
Error: undefined label 'CVB_NOSUCHTUNE' at line 4042
$ echo $?
0
$ ls -l a.sms
-rw-r--r-- 1 root root 32768 a.sms
```

Both the headless build and the compiler Worker now judge each stage on what
it printed, not on what it returned. A regression test asserts the workaround
is still in place, and deliberately checks that the bogus ROM still gets
written — so if a future gasm80 fixes this, the test says so instead of
quietly leaving dead code behind.

This is also why `playMusic` and `stopMusic` were removed from the emitter
rather than left as no-ops. Music is not implemented, and `PLAY <name>` for a
tune that does not exist assembles to an undefined label — the exact failure
above. A block that can silently produce a corrupt cartridge is worse than a
missing feature.

## NOT is not not

CVBasic's `NOT` is a bitwise complement, not a logical negation:

```basic
IF NOT CONT1.BUTTON THEN ...
```
```asm
    LD A,(joy1_data)
    AND 64
    CPL          ; 64 -> 191, 0 -> 255
    OR A         ; non-zero either way
    JP Z,...     ; never taken
```

`NOT <bit test>` is therefore **always true**. Two things depended on it and
both were broken:

- the game over screen's `WHILE NOT CONT1.BUTTON` never exited, so pressing
  the button did nothing at all and the screen hung forever;
- the `not` block in the language silently always fired, so any script using
  it did the opposite of what it said.

The only form that actually negates is a comparison against zero, and a test
now fails if `NOT` reaches generated source at all.

This one is worth dwelling on because it compiled, ran, drew the right
screen, and read as correct in review. The generated line looked exactly like
what a person would write.

## Blocks that compile and do nothing

Three blocks have shipped in this project doing nothing whatsoever:

- `game over` set `game_state = 2`, which nothing read;
- `play sound` set `sfx_id`, which nothing read;
- `tile below me is solid` tested `k_cell`, which nothing had filled — so it
  returned whatever the last unrelated probe had left there.

All three compiled. All three passed every source-level test. All three were
found by a person playing the game, which is the worst way to find anything.

They share one shape: no sample used them. So `examples/kitchen-sink.json`
uses every statement, every condition and every expression form the language
can produce, and two tests keep it honest in both directions — every `case`
in the emitter must be reached by the sample, and every op the block lowering
can produce must have a `case`. Adding a block without a sample now fails the
build.

It is not a game and is not meant to be one. Its playtest checks liveness
rather than fun: that it keeps running, that the pool stays in range, that
sound reaches the PSG, and that the room flow fires.

## The block layer had never been run

Every test in this project fed the generator hand-written `stmts` arrays -
which is exactly the shape `blockly-lower.js` is supposed to produce. The
generator was therefore well covered and the thing that feeds it was covered
not at all. Blockly runs headlessly as long as you never inject a workspace
into a page, so `tools/test-blocks.mjs` builds real block trees with real
fields and real connections, and walks them all the way to a ROM.

Most of it passed first time. One thing did not, and it was the kind of bug
this project keeps producing:

**`Blockly.Xml.textToDom` was removed in Blockly 10** and moved to
`Blockly.utils.xml`. The editor called it when restoring a saved script,
inside a `try/catch` that logged and continued - so every time you switched
scripts the workspace came back **empty**, with nothing on screen to say why.
To the person using it, that is losing your work.

Two changes came out of it. The parse now happens *before* the workspace is
cleared, so a failure leaves what is on screen alone rather than destroying
it. And a test resolves every `Blockly.x.y(...)` call in the editor against
the installed library, so the next API move fails a build instead of a user's
afternoon. That test was checked by reintroducing the bug and confirming it
fails.

The dependency was also pinned to the version actually tested. It had been
asking for Blockly 6 while nothing had ever run against any version.

## Two ways the editor was quietly broken

Neither of these could show up in the headless build, because the headless
build copies the whole `engine/` directory while the browser has to ship each
file explicitly. Both were found by writing the first test that looked.

**The browser was missing two engine files.** Splitting `k_render` into
`render_sms.bas` and `render_tms.bas` for the SG-1000 work meant the compiler
Worker — which writes engine sources into the compiler's in-memory filesystem
before each build — was shipping three files out of five. Every build in the
editor would have failed with an undefined label, while every headless build
carried on working perfectly. A test now asserts the list matches the
directory.

**CVBasic and gasm80 disagree about capitals.** CVBasic prints
`ERROR: Bad nested END IF at line 2`; gasm80 prints `Error: undefined label`.
The build pipeline tested for `/^Error:/`, which matches one and misses the
other — so, on top of the exit codes already not being trustworthy, half of
all compiler failures were being read as successes. The check is now
case-insensitive in all four places that make it.

The error-to-block mapping that all of this feeds — the reason codegen emits
`' @blk:` markers at all — had also never been executed. It now has a test
that deliberately breaks one block and insists the error lands on that block
and not another, and a second that insists an error with no marker above it
is reported as a bug in the tool rather than blamed on the person using it.

## Two dead controls in the editor

The front end is the one part of this project that has never been executed -
building it needs a WASM toolchain that is not available here - so it is the
largest unverified surface left. Two checks that need no browser found two
real faults in it:

**Every name a template uses must be something its script defines.** Compile
each template, pull the instance properties out of the compiled render
function, and compare against the props, data, computed, methods and setup
returns the script declares. A mismatch renders blank or throws at runtime
and nothing upstream notices.

**Every event a component emits must have a listener.** This one found both:

- `SpriteEditor` emitted `onion` and nobody listened, so the "show previous
  frame" toggle was a button that did nothing.
- `BlocklyWorkspace` emitted `load-error` and nobody listened, so a script
  that failed to reopen failed in silence.

Same shape as `game over`, `play sound` and `tile below me`: wired at one
end, connected to nothing at the other, and invisible until someone tries
it. The onion toggle now lives in the actor editor, where it survives
changing frames, and the load error is shown in the workspace's own header
next to the script that failed.

Beyond the static checks, the three components that carry real logic and no
imports - the budget meter, the sprite editor and the code panel - are mounted
in a jsdom and read back: that the gauges show the IR's numbers rather than
placeholders, that RAM stops being labelled an estimate once the compiler has
reported, that being over budget produces advice with a button, and that
pressing that button actually emits an action.

Those run in their own process. Vue's test utilities patch the copy of Vue
they find at load time, and mounting turned out sensitive enough to module
ordering that mixing it into a file which had already loaded the template
compiler produced components that mounted to nothing - no error, no warning,
`$children` simply empty. Rather than depend on getting that order right, the
rendering tests do their DOM setup first and nothing else.

## Two parsers that matched nothing

The live inspector and the profiler are the reason the tool keeps gasm80's
symbol file and listing: the symbols map `ARRAY_E_X` to a RAM address so the
editor can read the entity pool out of a running game and draw hitboxes over
it, and the listing maps ROM addresses back to procedures so a PC sample can
be attributed to one actor's script.

Both parsers were written from an assumption about the format. Against a real
file, `parseSymbols` matched **0 of 479 lines** and `buildProcRanges` found
**0 procedures**. gasm80 writes

```
ARRAY_E_X: equ 0000c211h
1EBE                    07391 CVB_K_RENDER:
```

- addresses are eight hex digits with a trailing `h`, not four and bare;
- there is an `equ` between the name and the value;
- every name is upper-cased, so a pattern looking for `cvb_` finds nothing.

None of that errors. A parser that finds no symbols looks exactly like a game
with no symbols, so the whole feature would have been quietly inert.

The fix was the same shape as `blame.js`: move the parsing out of the Vue
hook, which cannot be loaded outside a browser build, into
`src/generators/symbols.js`, which can. It now reads 478 symbols and 101
procedure ranges from the shmup, and the tests check the ranges do not
overlap, that samples land in the right procedure, that the pool round-trips
through a fake machine, and that a missing symbol table returns null rather
than an invented pool.

One of those tests compares the result against the Python playtest harness's
own independent reader. That one was written against a real file and was
right all along; having the two agree is what would have caught this
immediately.

## What deleting an actor forgets

The project store is the editor's model layer - every change a person makes
goes through it - and none of it had ever run. It loads in Node once the
composition API has a Vue instance registered and `localStorage` is stood in
for, which is about ten lines.

The destructive mutations are the ones worth checking, and one of them was
incomplete. Deleting an actor strips its placements and any Shoot behaviour
aimed at it, but a `spawn` block sitting inside a script keeps pointing at
it - including one nested inside an `if`. The generator's response to a
spawn it cannot resolve is `if (!t) break;`, so the block stays in the
workspace looking perfectly correct and emits nothing at all. Forever.

The fix is not to delete the block. Placements and behaviour targets are
structural: a position with nothing to put there means nothing. A `spawn`
block is something the person wrote, inside a script they may still want, and
silently removing authored work is its own kind of bad. So it stays and the
lint reports it as an error, naming the script and carrying the block id so
the editor can highlight it.

That distinction - structural references get cleaned up, authored ones get
reported - is now the rule, and it is the only rule that never loses work
without saying so.

Eighteen other checks came out clean: the first actor created becomes the
player and later ones do not steal the flag, ids stay unique across
deletions, the field budget counts a 16-bit field as two slots, the last room
cannot be deleted, adding an animation frame copies the previous one rather
than starting blank (and deep-copies it, so editing one frame does not edit
both), and a project survives both the autosave round trip and the zip
export.

## The editor could not boot

The front end had been built for the first time, and it failed before
rendering anything. `main.js` read:

```js
import Vue from 'vue';
import VueCompositionApi from '@vue/composition-api';

Vue.use(VueCompositionApi);

import App from './App.vue';
```

Which looks right, and is not. ES modules evaluate every import before any
statement in the body, so `App.vue` - and through it `hooks/project.js`,
which calls `ref()` at module scope - ran before the `Vue.use` did. The
plugin could not find Vue, `Vue.observable` was undefined, and the whole
editor died with an error naming neither file.

Nothing else in the suite could have caught it. The components are mounted
individually elsewhere, which bypasses `main.js` entirely. The fix is to move
the install into its own module and import it first, because imports *are*
evaluated in source order - and `tools/test-boot.mjs` now loads the built
bundle in a jsdom and checks the shell, the tabs and the empty state actually
appear.

Two smaller ones found by the same build:

**The repository could not be built at all.** `"type": "module"` in
package.json - added so the Node tools could use ESM - made `vue.config.js`,
`babel.config.js` and `.eslintrc.js` be parsed as ES modules while they were
written as CommonJS. They are `.cjs` now.

**The lint had never run.** Forty-nine errors, almost all style, plus
`vue/no-mutating-props` on the actor editor. That last one is switched off
deliberately: these components *are* editors for the object they are handed,
the project document is the single source of truth, and threading every text
field through an event so the parent could write the same property back would
put the real state in two places.

## The first real use of the editor

The editor had been built, booted and tested in pieces. The first time a
person actually used it, five things were wrong within minutes, and none of
them was visible to any test that existed.

**A third of the screen was empty on every tab.** Vuetify gives `.v-tabs`
`flex: 1 1 auto`. In a column next to the tab content, which was `flex: 1`,
the bar and the content split the spare height between them: the strip of
tabs sat at the top of its half and the rest of that half was blank. The
arithmetic matched the screenshot to the pixel - 595 px of pane, 48 of tabs,
20 of padding, the spare 527 split 263.5 each, so the content began at
133 + 48 + 263.5 = 445 px, which is exactly where it did begin. jsdom does no
layout, so a test can only pin the override, not measure it.

**Placing actors did nothing.** The actor to place was chosen once, when the
Rooms tab first mounted. Opening Rooms before creating an actor - the obvious
way to explore - left it `null` forever, and the click handler began
`if (!this.placeActor) return;`. The choice is now derived: whatever was
picked if it still exists, otherwise the first actor, and with no actors at
all the canvas says so.

**There was no way to choose a tile, because there were no tiles.**
`paintTile: 1` was hardcoded, a new project had an empty tile set, and the
app had no tile editor anywhere. "Paint tiles" painted references to a tile
that did not exist. Projects now start with a small set (empty, brick, stone,
grass, spikes, sky); old projects with no tiles get it on load, which turns
their dangling references into bricks; there is a palette, a pixel editor for
tiles, and attribute flags. Deleting a tile remaps every room, because rooms
store indices and removing tile 3 would otherwise shift the whole map onto
the wrong art.

**Painting needed a click per cell.** Only `click` was wired. The canvas now
paints on drag, erases on right-drag, ends a stroke even when the button is
released off the canvas, and reports one change per stroke rather than one
per cell - every change wakes the budget meter and the autosave.

**`set my speed` did nothing at all** - the fourth block to compile and have
no effect. Velocity was only ever applied by a movement behaviour, so an
actor with none never moved. Underneath that were two more faults: the
lowering rounded speeds although the block offers quarter pixels, and the
emitter always wrote sixteenths of a pixel although most actor types now use
the whole-pixel mover - so had it moved, `1` would have meant 16 px a frame.
Verified on the emulated hardware: 1, 2, 0.5 and -1 now move 20, 40, 10 and
-20 px in 20 frames.

**Examples could not be offered as they were.** They store the lowered
program and no Blockly XML, so opened in the editor every script would have
been an empty workspace - and the first edit would have lowered that
emptiness over the real program. `blockly-raise.js` rebuilds blocks from the
program, and a test holds every offered example to an exact round trip,
block ids included. A script using something with no block (raw source, the
frame counter, a second pad) is shown as far as possible and protected from
being saved over, rather than partly deleted.

## The test runner had the same disease

Running the full suite after all that reported 195 passing, down from 222. Two
whole suites - template checks and component rendering - were not running.

The cause was a dependency range: `"vue": "2.6.*"` beside
`"vue-template-compiler": "^2.6.14"`, and the caret resolves to 2.7, which
refuses to load against Vue 2.6. A hand-installed matching version had been
masking it, so the source as shipped produced an untestable tree on a fresh
install. Both are pinned to 2.6.14 now, and the test utilities that had been
installed with `--no-save` are declared, so `npm install` gives the tree the
tests expect.

The worse part was why nobody noticed. The parent runner collected only the
`ok` and `FAIL` lines from each sub-suite. A suite that crashed while loading
printed neither, so it contributed nothing and the total stayed green; the
rendering suite caught its own load error and called it a skip. That is the
same shape as every dead block in this document - wired at one end, connected
to nothing at the other - and it was in the thing meant to catch them.

Every suite now has to end with a verdict. A crash is a failure with the tail
of its output shown, a skip has to say why, and "installed but will not load"
is a failure rather than a skip. That was checked by breaking a suite on
purpose: the runner reported `FAIL tools/test-ui.mjs did not finish`.

## Driving the built editor

`tools/test-e2e.mjs` loads `dist/` into a jsdom with real script loading,
webpack fetching its own lazy chunks through a request interceptor, and a
real 2D canvas from the `canvas` package, then walks through what was
reported broken in the order a person would meet it: open Rooms with no
actors, create one, place it, choose a tile, paint a run of cells with one
drag, erase with the right button - and then read the canvas pixels back to
check the tiles are actually drawn, grass green and empty cells not. Then it
opens an example from the Open menu and checks the Ship's collision script
comes up as nine real blocks with the program unchanged.

With a real canvas installed the whole walk produces no errors at all. Without
it, Blockly cannot measure text and the room canvas cannot draw, which is the
harness's limitation rather than the editor's - so the canvas is an optional
dependency, and the test says when drawing went unchecked.

## Compiling in the browser

The editor could do everything except build a ROM, because the in-browser
compilers needed Emscripten and its SDK downloads from a host this project
could not reach. They do not need Emscripten. CVBasic and gasm80 are plain C
that read and write files, and Zig - which is on PyPI - ships a clang and a
WASI libc that target WebAssembly directly. Two commands produced
`cvbasic.wasm` (213 KB) and `gasm80.wasm` (67 KB), and the shmup they built
was byte-identical to the native one on the first attempt.

The interesting work was in what surrounds them:

| | |
|---|---|
| shmup | 32,768 bytes, identical to native, 290 ms |
| platformer | identical, 80 ms |
| kitchen sink | identical, 100 ms |
| SG-1000 shmup | identical, 70 ms |

(The first build pays for compiling the two modules; later ones do not.)

- **Silence by default.** The WASI runtime treats a missing `debug` option as
  on, and logged every file the compilers opened, on every build.
- **No root-relative paths.** The hook asked for the compilers at `/wasm/`,
  which only works when the editor is served from the root of a site - and
  being able to host it anywhere had been one of its promises.
- **Failures that say what they are.** The Play tab used to offer a
  "Show hitboxes" checkbox whose caption described reading the entity pool
  live from the emulator. Nothing read the checkbox, and nothing read the
  emulator. It is gone. And an exception while starting the emulator - no
  network, a missing browser API - used to leave a silent black rectangle;
  it now says so next to a Download button, because the ROM is good either
  way.

The end-to-end test opens an example, presses Play, captures the ROM on its
way to the emulator, and requires it to match the native build byte for
byte. jsdom has neither Workers nor `fetch`, so the build runs on the page -
the same code the Worker runs - and the harness supplies `fetch`.

## Bundling the emulator

Play loaded EmulatorJS from `@emulatorjs/emulatorjs@latest` on jsdelivr: a
network request on every Play, and an unpinned one, so the emulator could
change under the editor without notice. It is now release 4.2.3, vendored
into `public/emulator/` by a script.

A full release is 303 MB, nearly all of it cores for other machines. What
the Master System needs is 2.9 MB, and finding the exact set meant reading
the frontend rather than guessing:

- `segaMS` maps to `["smsplus", "genesis_plus_gx", "picodrive"]`; the first is
  the default, so smsplus is the core.
- The build is chosen as `core + (threads ? "-thread" : "") + (webgl2 ? "" :
  "-legacy") + "-wasm.data"`. Threads need a cross-origin-isolated page *and*
  an opt-in, so the threaded builds are never loaded from a plain static
  server. WebGL 2 is only used when the core's report says so, and smsplus's
  report says nothing - so by default the *legacy* build is the one loaded.
  Keeping only the obvious one would have broken it for everyone.
- There is no separate SG-1000 system; SG-1000 cartridges go through the same
  core, which picks its mode from the file extension. For a blob URL that
  name comes from `EJS_gameName`, so the editor names SG-1000 ROMs `game.sg` -
  and the core's own `core.json` lists both `sms` and `sg`.

Two behaviours would have quietly undone the bundling, and both work fine
online, which is why neither would ever have been noticed:

- **A missing core is fetched from `cdn.emulatorjs.org` instead.** So the
  end-to-end test records every request Play makes and fails on any that
  leave the machine, and requires the core it asks for to exist in the bundle.
- **An update check runs whenever the editor is served from localhost** -
  which is how everyone runs it. The vendoring script disables that one call
  by replacing an exact expression, and refuses to proceed if a future
  release changes it.

With both handled, pressing Play makes no request to anywhere but the server
the editor came from. jsdom can follow the emulator as far as handing its core
to the decompression Worker; running the core needs WebGL, which no headless
DOM has, so the last step - the game actually on screen - is verified by
opening it in a browser, not by this suite.

Bundling also exposed two harness problems. The editor instance opened
*without* Workers, to test the in-page compile fallback, let the emulator try
to start its own Worker and throw - asynchronously, straight into Node,
killing the run on some timings and not others. That instance now has no
emulator, and any error escaping a page is collected and reported by a test
instead of aborting the process. And a check written to catch the compiler's
Worker failing caught the emulator's instead, so it now distinguishes them:
the editor's worker is a script under `js/`, never a `blob:` URL.

## Two emulators at once

Reported from real use: pressing Play a second time opened a second emulator
while the first kept running.

Stopping the emulator meant `host.innerHTML = ''`. That removes the picture
and leaves the program. EmulatorJS's main loop, its audio, its gamepad poll -
a timer rescheduling itself every 10 ms - and its window listeners all carried
on, detached from the page. And each Play re-ran `loader.js`, which loaded
`emulator.min.js` again every time: after three Plays, three copies.

A test reproduced both before anything changed: after a second Play the first
emulator's gamepad timer was still ticking, and the page held three copies of
the frontend.

EmulatorJS has no destroy. Its own Exit button fires an `exit` event, which
stops the core's main loop and aborts it a second later; the editor now fires
that, and also does what `exit` leaves out - the gamepad poll, the audio
context, the element.

The harder part was a race. EmulatorJS is configured through globals and
constructed asynchronously: `loader.js` reads `EJS_gameUrl` after awaiting its
scripts and a translation file, then assigns `window.EJS_emulator`. Press Play
twice quickly and the first emulator arrives *after* it was meant to be
stopped, with nothing holding it to stop it - so it finishes loading and
plays. `window.EJS_emulator` is now a property the editor owns, every
instance is matched to the Play that asked for it as it is constructed, and
one that arrives for a Play since superseded or ended is shut down before it
can start. An emulator that is stopped while still loading has its remaining
pipeline steps replaced with no-ops, so whichever comes next is the last.

The loader is patched in `tools/vendor-emulator.py` to load the frontend only
once, asserted the same way as the update-check patch.

The race cannot be hit reliably end to end, so it is tested directly with
stand-in emulators: two Plays before either arrives, a Play ended before its
emulator arrives, a Play whose loader failed. Breaking the arrival check on
purpose fails exactly the two race tests.

## Reproducing

```sh
node tools/build.mjs examples/shmup.json        # prints the budget
python3 tools/cycles.py out/shmup.asm scenarios.py
python3 tools/sms.py out/shmup.sms --frames 40 --png out/frame.png
python3 tools/playtest.py out/shmup.sms out/shmup.sym
node tools/test-blocks.mjs          # needs npm install
```

`tools/cycles.py` takes a scenario file mapping a name to a start label and
the branches to follow:

```python
{
 'inner: active, rejected on Y': {
   'start': 'cv70', 'taken': {'cv71': False, 'cv72': True}},
}
```

Labels come from the generated `.asm`; CVBasic emits each source line as a
comment above its own code, so finding the label for a given line of the
kernel is a matter of searching for the line.
