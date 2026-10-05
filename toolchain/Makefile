# Builds cvbasic and gasm80 - natively for the headless tools, and as
# WebAssembly for the editor.
#
# The browser build used to require Emscripten, which this project could not
# reach from where it was developed. It no longer needs it. Both compilers are
# plain C that read and write files, and Zig ships a complete clang plus a
# WASI libc that targets WebAssembly directly. Zig is on PyPI, so:
#
#     pip install ziglang==0.16.0
#     make -C toolchain wasm
#
# produces public/wasm/cvbasic.wasm and gasm80.wasm (about 280 KB together),
# which the editor runs in a Web Worker through a small JavaScript WASI
# runtime. The ROMs they produce are byte-identical to the native build's;
# tools/test-wasm.mjs checks that for every sample on every run.
#
# Pinned to the same commits CVBasic-emscripten uses, so the prologue and
# epilogue .asm files shipped beside the .wasm match the compiler exactly.

CVBASIC_COMMIT = ee31cebaff08f8ce1aeea0074d4fc641201ffee7
GASM80_COMMIT  = 374975b36c9e738a059c9859930c96ed1ce12f14
OUT            = ../public/wasm
ZIGCC         ?= python3 -m ziglang cc
WASMFLAGS      = --target=wasm32-wasi -O2 -s

.PHONY: all wasm native sources clean

all: wasm native

sources: CVBasic gasm80

CVBasic:
	git clone https://github.com/nanochess/CVBasic $@
	cd $@ && git checkout -q $(CVBASIC_COMMIT)

gasm80:
	git clone https://github.com/nanochess/gasm80 $@
	cd $@ && git checkout -q $(GASM80_COMMIT)

wasm: sources
	@mkdir -p $(OUT)
	cd CVBasic && $(ZIGCC) $(WASMFLAGS) \
	  cvbasic.c node.c driver.c cpu6502.c cpuz80.c cpu9900.c \
	  -o ../$(OUT)/cvbasic.wasm
	cd gasm80 && $(ZIGCC) $(WASMFLAGS) gasm80.c -o ../$(OUT)/gasm80.wasm
	# Only the Z80 prologue and epilogue: every target the editor offers is
	# a Z80 machine.
	cp CVBasic/cvbasic_prologue.asm CVBasic/cvbasic_epilogue.asm $(OUT)/

# Native builds, for tools/build.mjs and the test suite.
native: sources
	@mkdir -p ../bin/asm
	cd CVBasic && $(MAKE) && cp cvbasic ../../bin/ && cp *.asm ../../bin/asm/
	cd gasm80 && $(MAKE) && cp gasm80 ../../bin/

clean:
	rm -rf CVBasic gasm80 $(OUT)/*.wasm $(OUT)/*.asm
