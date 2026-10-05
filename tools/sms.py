#!/usr/bin/env python3
"""
A headless Sega Master System, just complete enough to see the screen.

`06-roadmap-and-risks.md` lists "generated code hits a CVBasic edge case" as a
risk and answers it with a suite that compiles every sample. Compiling is not
the same as working: the shmup compiled cleanly, reported 91% of a frame, and
drew corrupted sprites. Nothing in the pipeline could have caught that,
because nothing in the pipeline had ever looked at a pixel.

This runs the ROM on a real Z80 core with enough VDP to render a frame, then
dumps the screen as text or a PNG. It is deliberately not a good emulator -
no sound, no scrolling, no sprite collision, approximate timing - but it is
enough to answer "is there a spaceship on the screen", which is the question
that matters.

    python3 tools/sms.py out/shmup.sms --frames 12 --ascii
    python3 tools/sms.py out/shmup.sms --frames 12 --png out/frame.png
    python3 tools/sms.py out/shmup.sms --sprites      # decode the SAT
"""

import argparse
import sys

import z80


class VDP:
    """Mode 4 VDP: enough for the name table, sprites and palette."""

    def __init__(self):
        self.vram = bytearray(0x4000)
        self.cram = bytearray(32)
        self.regs = bytearray(16)
        self.addr = 0
        self.code = 0
        self.latch = None
        self.read_buffer = 0
        self.status = 0
        self.line = 0
        self.tms = False
        self.sprites_drawn = 0

    def write_control(self, value):
        if self.latch is None:
            self.latch = value
            return
        low, self.latch = self.latch, None
        self.addr = ((value & 0x3F) << 8) | low
        self.code = (value >> 6) & 3
        if self.code == 2:
            reg = value & 0x0F
            self.regs[reg] = low
        elif self.code == 0:
            self.read_buffer = self.vram[self.addr]
            self.addr = (self.addr + 1) & 0x3FFF

    def read_control(self):
        self.latch = None
        s, self.status = self.status, 0
        return s

    def write_data(self, value):
        self.latch = None
        if self.code == 3:
            self.cram[self.addr & 0x1F] = value
        else:
            self.vram[self.addr] = value
        self.addr = (self.addr + 1) & 0x3FFF

    def read_data(self):
        self.latch = None
        v, self.read_buffer = self.read_buffer, self.vram[self.addr]
        self.addr = (self.addr + 1) & 0x3FFF
        return v

    # ---- accessors the renderer and the tests use ----

    @property
    def name_table(self):
        return ((self.regs[2] & 0x0E) << 10) & 0x3FFF

    @property
    def sprite_attr_table(self):
        return ((self.regs[5] & 0x7E) << 7) & 0x3FFF

    @property
    def sprite_pattern_base(self):
        return 0x2000 if (self.regs[6] & 4) else 0x0000

    @property
    def display_on(self):
        return bool(self.regs[1] & 0x40)

    @property
    def mode4(self):
        """SMS Mode 4 versus a TMS9918 graphics mode."""
        return bool(self.regs[0] & 4)

    # ---- TMS9918 Graphics II ----

    @property
    def tms_name_table(self):
        return (self.regs[2] & 0x0F) * 0x400

    @property
    def tms_pattern_base(self):
        return (self.regs[4] & 0x04) << 11

    @property
    def tms_colour_base(self):
        return (self.regs[3] & 0x80) << 6

    @property
    def tms_sprite_attr(self):
        return (self.regs[5] & 0x7F) << 7

    @property
    def tms_sprite_pattern(self):
        return (self.regs[6] & 0x07) << 11

    @property
    def tms_sprites_16(self):
        return bool(self.regs[1] & 2)

    @property
    def sprites_8x16(self):
        return bool(self.regs[1] & 2)

    def pattern_pixel(self, pattern, x, y):
        """4bpp planar: four bytes per row, one bit per plane."""
        base = (pattern * 32 + y * 4) & 0x3FFF
        bit = 7 - x
        v = 0
        for plane in range(4):
            v |= ((self.vram[base + plane] >> bit) & 1) << plane
        return v

    def render(self):
        if not self.mode4:
            return self.render_tms()
        return self.render_mode4()

    def render_tms(self):
        """
        TMS9918 Graphics II.

        The screen is three independent banks of 256 characters, one per
        eight rows, each with its own pattern and colour data. Colour is per
        eight-pixel row rather than per pixel, and a sprite has a single
        colour for all of its pixels - which is why art for these targets is
        a one-bit mask.

        Colour indices here are TMS indices, not entries in a palette the
        program loaded, so `cram` is filled with the fixed TMS palette and
        the rest of this file does not need to care which VDP it is looking
        at.
        """
        screen = [[(0, False)] * 256 for _ in range(192)]
        nt = self.tms_name_table
        pat = self.tms_pattern_base
        col = self.tms_colour_base
        # R3 and R4 carry mask bits that limit which banks are distinct.
        pmask = ((self.regs[4] & 0x03) << 8) | 0xFF
        cmask = ((self.regs[3] & 0x7F) << 3) | 0x07

        for row in range(24):
            bank = (row // 8) * 0x800
            for c in range(32):
                ch = self.vram[(nt + row * 32 + c) & 0x3FFF]
                idx = (bank + ch * 8)
                for y in range(8):
                    pb = self.vram[(pat + (idx & (pmask * 8 | 7)) + y) & 0x3FFF]
                    cb = self.vram[(col + (idx & (cmask * 8 | 7)) + y) & 0x3FFF]
                    fg, bg = cb >> 4, cb & 15
                    sy = row * 8 + y
                    for x in range(8):
                        on = (pb >> (7 - x)) & 1
                        v = fg if on else bg
                        screen[sy][c * 8 + x] = (v, False)

        # Sprites: 4 bytes each, Y first, 0xD0 terminates, Y is one less than
        # the row the sprite actually starts on.
        sat = self.tms_sprite_attr
        spat = self.tms_sprite_pattern
        size = 16 if self.tms_sprites_16 else 8
        drawn = 0
        for i in range(32):
            sy = self.vram[(sat + i * 4) & 0x3FFF]
            if sy == 0xD0:
                break
            sx = self.vram[(sat + i * 4 + 1) & 0x3FFF]
            name = self.vram[(sat + i * 4 + 2) & 0x3FFF]
            attr = self.vram[(sat + i * 4 + 3) & 0x3FFF]
            colour = attr & 15
            if attr & 0x80:
                sx -= 32                      # early clock: shift 32 left
            sy = (sy + 1) & 0xFF
            if sy > 192 and sy < 240:
                continue
            if sy >= 240:
                sy -= 256
            if not colour:
                continue
            drawn += 1
            base = spat + (name & (0xFC if size == 16 else 0xFF)) * 8
            for qy in range(size):
                for qx in range(size):
                    # A 16x16 sprite is four 8x8 patterns in column order:
                    # left top, left bottom, right top, right bottom.
                    quad = (qx // 8) * 2 + (qy // 8)
                    byte = self.vram[(base + quad * 8 + (qy % 8)) & 0x3FFF]
                    if not ((byte >> (7 - (qx % 8))) & 1):
                        continue
                    px, py = sx + qx, sy + qy
                    if 0 <= px < 256 and 0 <= py < 192:
                        screen[py][px] = (colour, True)
        self.sprites_drawn = drawn
        for i, rgb in enumerate(TMS_PALETTE):
            self.cram[i] = i                  # indices, resolved at paint time
        self.tms = True
        return screen

    def render_mode4(self):
        """Return a 256x192 grid of (colour_index, is_sprite)."""
        screen = [[(0, False)] * 256 for _ in range(192)]

        # Background.
        nt = self.name_table
        for row in range(24):
            for col in range(32):
                entry = nt + (row * 32 + col) * 2
                low = self.vram[entry]
                high = self.vram[entry + 1]
                pattern = low | ((high & 1) << 8)
                hflip = high & 2
                vflip = high & 4
                palette = 16 if (high & 8) else 0
                for y in range(8):
                    sy = row * 8 + y
                    if sy >= 192:
                        continue
                    py = 7 - y if vflip else y
                    for x in range(8):
                        px = 7 - x if hflip else x
                        v = self.pattern_pixel(pattern, px, py)
                        screen[sy][col * 8 + x] = (palette + v, False)

        # Sprites. Y == 0xD0 terminates the list in 192-line mode.
        sat = self.sprite_attr_table
        height = 16 if self.sprites_8x16 else 8
        drawn = 0
        for i in range(64):
            sy = self.vram[sat + i]
            if sy == 0xD0:
                break
            sy = (sy + 1) & 0xFF
            sx = self.vram[sat + 0x80 + i * 2]
            pattern = self.vram[sat + 0x80 + i * 2 + 1]
            if self.sprites_8x16:
                pattern &= 0xFE
            base = self.sprite_pattern_base // 32
            drawn += 1
            for y in range(height):
                py = sy + y
                if not (0 <= py < 192):
                    continue
                for x in range(8):
                    pxs = sx + x
                    if not (0 <= pxs < 256):
                        continue
                    v = self.pattern_pixel(base + pattern + (y // 8), x, y % 8)
                    if v:
                        screen[py][pxs] = (16 + v, True)
        self.sprites_drawn = drawn
        return screen


class SMS:
    def __init__(self, rom):
        self.rom = bytearray(rom)
        self.ram = bytearray(0x2000)
        self.vdp = VDP()
        self.cpu = z80.Z80Machine()
        # This core runs against a flat 64K memoryview and only calls back on
        # explicitly marked addresses, so the ROM goes straight in. The
        # cartridge slot is read-only on real hardware, but CVBasic never
        # writes below $c000, so a flat image is close enough and much
        # faster than a callback per access.
        self.cpu.memory[0:len(self.rom)] = self.rom
        self.cpu.set_input_callback(self.input)
        self.cpu.set_output_callback(self.output)
        self.pad = 0xFF
        self.vcounter = 0
        self.stalled = False

    def read(self, addr):
        return self.cpu.memory[addr]

    def write(self, addr, value):
        self.cpu.memory[addr] = value

    def input(self, port):
        p = port & 0xFF
        if p == 0x7E:
            return self.vcounter
        if p == 0x7F:
            return 0
        if p == 0xBE:
            return self.vdp.read_data()
        if p == 0xBF or p == 0xBD:
            return self.vdp.read_control()
        if p == 0xDC or p == 0xC0:
            return self.pad
        if p == 0xDD or p == 0xC1:
            return 0xFF
        return 0xFF

    def output(self, port, value):
        p = port & 0xFF
        if p == 0xBE:
            self.vdp.write_data(value)
        elif p == 0xBF or p == 0xBD:
            self.vdp.write_control(value)
        return 0

    def run_frames(self, n, guard=600):
        """
        Drive the machine off HALT rather than off a cycle count.

        CVBasic's WAIT compiles to a bare HALT and every engine frame ends on
        one, so "run until the program parks itself, then deliver VBlank" is
        both the simplest model and an exact one for this class of program.
        The sprite attribute upload happens inside the interrupt handler, so
        without the interrupt nothing ever reaches the VDP.
        """
        for _ in range(n):
            steps = 0
            while not self.cpu.halted and steps < guard:
                self.cpu.ticks_to_stop = 20000
                self.cpu.run()
                steps += 1
            if steps >= guard:
                self.stalled = True
            self.vdp.status |= 0x80
            self.vcounter = 0xC0
            self.interrupt()
        # Let the handler finish and the next frame's logic run.
        for _ in range(40):
            if self.cpu.halted:
                break
            self.cpu.ticks_to_stop = 20000
            self.cpu.run()

    def interrupt(self):
        """IM 1: push PC, jump to $38."""
        # Clear the halt, but do NOT advance PC: this core already reports
        # PC as the address after the HALT instruction. Advancing it again
        # pushes a return address one byte into the following instruction,
        # so the first CALL after WAIT gets silently skipped - which looks
        # exactly like "the game's behaviours never run".
        self.cpu.halted = False
        self.cpu.iff1 = 0
        self.cpu.iff2 = 0
        sp = (self.cpu.sp - 2) & 0xFFFF
        pc = self.cpu.pc
        self.cpu.memory[sp] = pc & 0xFF
        self.cpu.memory[(sp + 1) & 0xFFFF] = pc >> 8
        self.cpu.sp = sp
        self.cpu.pc = 0x38


# The TMS9918's fixed 16-colour palette, as commonly measured.
TMS_PALETTE = [
    (0, 0, 0), (0, 0, 0), (33, 200, 66), (94, 220, 120),
    (84, 85, 237), (125, 118, 252), (212, 82, 77), (66, 235, 245),
    (252, 85, 84), (255, 121, 120), (212, 193, 84), (230, 206, 128),
    (33, 176, 59), (201, 91, 186), (204, 204, 204), (255, 255, 255),
]


def cram_to_rgb(v):
    return (((v >> 0) & 3) * 85, ((v >> 2) & 3) * 85, ((v >> 4) & 3) * 85)


def to_ascii(screen, step=4):
    """Downsample to text. '.' is backdrop; sprite pixels use their index."""
    chars = '0123456789ABCDEF'
    out = []
    for y in range(0, 192, step):
        row = ''
        for x in range(0, 256, step // 2 if step > 1 else 1):
            idx, is_spr = screen[y][x]
            if is_spr:
                row += chars[idx & 15]
            elif idx & 15:
                row += ':'
            else:
                row += '.'
        out.append(row)
    return '\n'.join(out)


def to_png(screen, cram, path, tms=False):
    try:
        from PIL import Image
    except ImportError:
        print('Pillow not installed; skipping PNG', file=sys.stderr)
        return
    img = Image.new('RGB', (256, 192))
    px = img.load()
    for y in range(192):
        for x in range(256):
            idx, _ = screen[y][x]
            px[x, y] = TMS_PALETTE[idx & 15] if tms else cram_to_rgb(cram[idx & 31])
    img.resize((512, 384), Image.NEAREST).save(path)
    print(f'wrote {path}')


def dump_sprites(vdp, limit=12):
    if not vdp.mode4:
        sat = vdp.tms_sprite_attr
        print(f'  TMS SAT ${sat:04x}  patterns ${vdp.tms_sprite_pattern:04x}  '
              f'{"16x16" if vdp.tms_sprites_16 else "8x8"}  '
              f'display {"on" if vdp.display_on else "OFF"}')
        for i in range(32):
            y = vdp.vram[sat + i * 4]
            if y == 0xD0:
                print(f'  [{i}] terminator ($d0)')
                break
            if i < limit:
                print(f'  [{i}] y={y:3d} x={vdp.vram[sat + i * 4 + 1]:3d} '
                      f'pattern={vdp.vram[sat + i * 4 + 2]:3d} '
                      f'colour={vdp.vram[sat + i * 4 + 3] & 15}')
        return
    sat = vdp.sprite_attr_table
    print(f'  SAT ${sat:04x}  pattern base ${vdp.sprite_pattern_base:04x}  '
          f'{"8x16" if vdp.sprites_8x16 else "8x8"}  '
          f'display {"on" if vdp.display_on else "OFF"}')
    print('  reg1=${:02x} reg2=${:02x} reg5=${:02x} reg6=${:02x}'.format(
        vdp.regs[1], vdp.regs[2], vdp.regs[5], vdp.regs[6]))
    for i in range(64):
        y = vdp.vram[sat + i]
        if y == 0xD0:
            print(f'  [{i}] terminator ($d0)')
            break
        x = vdp.vram[sat + 0x80 + i * 2]
        n = vdp.vram[sat + 0x80 + i * 2 + 1]
        if i < limit:
            print(f'  [{i}] y={y:3d} x={x:3d} pattern={n:3d}')
    else:
        print('  no terminator found in 64 sprites')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('rom')
    ap.add_argument('--frames', type=int, default=10)
    ap.add_argument('--ascii', action='store_true')
    ap.add_argument('--png')
    ap.add_argument('--sprites', action='store_true')
    ap.add_argument('--vram')
    args = ap.parse_args()

    sms = SMS(open(args.rom, 'rb').read())
    sms.run_frames(args.frames)

    screen = sms.vdp.render()
    print(f'  frames={args.frames}  sprites drawn={sms.vdp.sprites_drawn}')
    if args.sprites:
        dump_sprites(sms.vdp)
    if args.ascii:
        print(to_ascii(screen))
    if args.png:
        to_png(screen, sms.vdp.cram, args.png, not sms.vdp.mode4)
    if args.vram:
        open(args.vram, 'wb').write(sms.vdp.vram)


if __name__ == '__main__':
    main()
