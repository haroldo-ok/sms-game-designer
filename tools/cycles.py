#!/usr/bin/env python3
"""
Static Z80 cycle counter for CVBasic output.

The one number every page of the design documents is sized around - "how
many collision tests actually fit in a frame" - was an estimate of 35 to 60.
This replaces it with a measurement taken from the real generated assembly.

It is a static count over a straight-line path, not a simulation: you give it
a label and a set of branches to follow, and it adds up T-states. That is
exactly right for the collision inner loop, which is straight-line code with
no data-dependent instruction timing on the Z80 beyond conditional-call and
block instructions, neither of which CVBasic emits here.
"""

import re
import sys

# T-states for the instruction forms CVBasic actually emits. On the Z80 a JP
# cc,nn costs 10 whether or not it is taken, which is what makes a static
# path count exact here.
TIMING = [
    (r'^LD A,\(HL\)$', 7), (r'^LD \(HL\),A$', 7),
    (r'^LD [ABCDEHL],\(HL\)$', 7), (r'^LD \(HL\),[ABCDEHL]$', 7),
    (r'^LD HL,\(\S+\)$', 16), (r'^LD (DE|BC|SP),\(\S+\)$', 20),
    (r'^LD \(\S+\),HL$', 16), (r'^LD \(\S+\),(DE|BC|SP)$', 20),
    (r'^LD A,\(\S+\)$', 13), (r'^LD \(\S+\),A$', 13),
    (r'^LD (HL|DE|BC|SP),\S+$', 10),
    (r'^LD [ABCDEHL],[ABCDEHL]$', 4),
    (r'^LD [ABCDEHL],\S+$', 7),
    (r'^ADD HL,(HL|DE|BC|SP)$', 11),
    (r'^(ADC|SBC) HL,(HL|DE|BC|SP)$', 15),
    (r'^(ADD|ADC|SUB|SBC|AND|OR|XOR|CP) A?,?[ABCDEHL]$', 4),
    (r'^(ADD|ADC|SUB|SBC|AND|OR|XOR|CP) A?,?\(HL\)$', 7),
    (r'^(ADD|ADC|SUB|SBC|AND|OR|XOR|CP) A?,?\S+$', 7),
    (r'^(INC|DEC) \(HL\)$', 11),
    (r'^(INC|DEC) (HL|DE|BC|SP|IX|IY)$', 6),
    (r'^(INC|DEC) [ABCDEHL]$', 4),
    (r'^(RLCA|RRCA|RLA|RRA|CPL|SCF|CCF|NEG|EXX|DAA)$', 4),
    (r'^EX DE,HL$', 4),
    (r'^(SLA|SRA|SRL|RL|RR|RLC|RRC|BIT|SET|RES).*\(HL\)', 15),
    (r'^(SLA|SRA|SRL|RL|RR|RLC|RRC|BIT|SET|RES)', 8),
    (r'^JP (NZ|Z|NC|C|PO|PE|P|M),', 10),
    (r'^JP \(HL\)$', 4),
    (r'^JP ', 10),
    (r'^JR (NZ|Z|NC|C),', 12),   # taken; 7 when not
    (r'^JR ', 12),
    (r'^DJNZ', 13),
    (r'^CALL (NZ|Z|NC|C|PO|PE|P|M),', 17),
    (r'^CALL ', 17),
    (r'^RET (NZ|Z|NC|C|PO|PE|P|M)$', 11),
    (r'^RET$', 10),
    (r'^(PUSH|POP) ', 11),
    (r'^(EI|DI)$', 4),
    (r'^(IN|OUT) ', 11),
    (r'^NOP$', 4),
    (r'^(LDIR|LDDR)$', 21),
    (r'^(LDI|LDD)$', 16),
]


def cost(instr):
    for pat, t in TIMING:
        if re.match(pat, instr, re.I):
            return t
    return None


def load(path):
    """Return (ordered list of (label_or_None, instruction), label index)."""
    out, labels = [], {}
    for raw in open(path):
        line = raw.split(';')[0].rstrip()
        if not line.strip():
            continue
        if not line[0].isspace():
            label = line.split(':')[0].strip()
            labels[label] = len(out)
            rest = line.split(':', 1)[1].strip() if ':' in line else ''
            if rest:
                out.append(rest)
            continue
        instr = line.strip()
        if instr.upper().startswith(('DB', 'DW', 'DS', 'RB', 'ORG', 'IF',
                                     'ENDIF', 'ELSE', 'INCLUDE', 'EQU',
                                     'FORG', 'END')):
            continue
        out.append(instr)
    return out, labels


def walk(code, labels, start, taken, limit=400):
    """
    Follow one straight-line path from `start`.

    `taken` maps a jump target label to True (follow it) or False (fall
    through). Stops at a label named in `taken` with value 'stop'.
    """
    pc = labels[start]
    total, trace, unknown = 0, [], []
    for _ in range(limit):
        if pc >= len(code):
            break
        instr = code[pc]
        c = cost(instr)
        if c is None:
            unknown.append(instr)
            c = 0
        total += c
        trace.append((instr, c))

        m = re.match(r'^JP\s+(?:(NZ|Z|NC|C|PO|PE|P|M)\s*,\s*)?(\S+)$', instr, re.I)
        if m:
            cond, target = m.group(1), m.group(2)
            decision = taken.get(target, None)
            if decision == 'stop':
                break
            if cond is None or decision:
                if target not in labels:
                    break
                pc = labels[target]
                continue
        if instr.upper().startswith('RET'):
            break
        pc += 1
    return total, trace, unknown


FRAME_NTSC = 59736  # 3.579545 MHz / 59.92 Hz


def main():
    path = sys.argv[1]
    code, labels = load(path)
    scenarios = eval(open(sys.argv[2]).read()) if len(sys.argv) > 2 else {}
    for name, spec in scenarios.items():
        total, trace, unknown = walk(code, labels, spec['start'], spec['taken'])
        pct = total / FRAME_NTSC * 100
        print(f'{name:38s} {total:6d} cycles  {pct:5.2f}% of an NTSC frame')
        if unknown:
            print('    unknown instructions:', set(unknown))
        if spec.get('verbose'):
            for i, c in trace:
                print(f'      {c:3d}  {i}')


if __name__ == '__main__':
    main()
