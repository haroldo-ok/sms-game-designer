#!/usr/bin/env python3
"""
Vendor a trimmed EmulatorJS release into public/emulator/.

The editor plays games in EmulatorJS, served from its own folder rather than
a CDN: no network on Play, and a pinned version that cannot change under the
editor. A full release is 303 MB, almost all of it cores for other machines.
This keeps what the Master System and SG-1000 need - about 2.9 MB - and does
it reproducibly, so the folder can be audited and upgraded instead of being
an opaque blob somebody once assembled by hand.

    pip install py7zr
    python3 tools/vendor-emulator.py            # release 4.2.3
    python3 tools/vendor-emulator.py --archive 4.2.3.7z   # from a local copy

What it keeps, and why:

  loader.js, emulator.min.js/.css   the frontend
  version.json                      read by the frontend
  localization/*.json               one is fetched to match the browser's
                                    language; all are small
  compression/extract7z.js,         the cores are 7-Zip archives, unpacked
  compression/extractzip.js         in a Worker by these
  cores/smsplus-wasm.data           the Master System core (EmulatorJS's
  cores/smsplus-legacy-wasm.data    default for segaMS) in both builds: the
                                    legacy one is what it loads unless WebGL 2
                                    is both available and switched on, which
                                    by default it is not
  cores/reports/smsplus.json        fetched before the core, to choose a build

What it leaves out: the other 185 cores, every threaded build (only loaded
on a cross-origin-isolated page with threads switched on, which a plain
static server never is), and the RAR decompressor.

One patch is applied, and it is asserted rather than hoped for. EmulatorJS
checks cdn.emulatorjs.org for a newer version whenever it is served from
localhost - which is how everyone runs this editor. That request changes
nothing about the game, but it means something leaves the machine on every
Play, and the editor says nothing does. The call is disabled by replacing
one exact expression; if a future release changes it, this script fails
instead of silently shipping the request again.

Everything written is listed with its SHA-256 in MANIFEST.txt, which the
test suite checks.
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
import urllib.request

try:
    import py7zr
except ImportError:
    sys.exit('needs py7zr:  pip install py7zr')

HERE = os.path.dirname(os.path.abspath(__file__))
DEST = os.path.join(HERE, '..', 'public', 'emulator')

KEEP = [
    'data/loader.js',
    'data/emulator.min.js',
    'data/emulator.min.css',
    'data/version.json',
    'data/compression/extract7z.js',
    'data/compression/extractzip.js',
    'data/cores/smsplus-wasm.data',
    'data/cores/smsplus-legacy-wasm.data',
    'data/cores/reports/smsplus.json',
    'LICENSE',
]
KEEP_DIRS = ['data/localization/']

# The update check, exactly as it appears in the minified 4.2.x frontend.
UPDATE_CHECK = '&&this.checkForUpdates()'
UPDATE_CHECK_OFF = '&&false/* update check disabled: see tools/vendor-emulator.py */'

# The loader runs on every Play and, unpatched, loads the frontend every time:
# another script tag and stylesheet per Play, and a second evaluation of a
# file whose top-level class declarations cannot be declared twice. Load it
# only if it is not already there.
LOADER_PATCHES = [
    ('await loadScript("emulator.min.js");',
     'if (typeof EmulatorJS === "undefined") await loadScript("emulator.min.js");'
     ' /* load once: see tools/vendor-emulator.py */'),
    ('await loadStyle("emulator.min.css");',
     'if (!document.querySelector(\'link[href$="emulator.min.css"]\'))'
     ' await loadStyle("emulator.min.css");'),
]

# The consoles the editor plays in-browser, by the extension it gives them.
REQUIRED_EXTENSIONS = ['sms', 'sg']


def fail(msg):
    sys.exit(f'vendor-emulator: {msg}')


def version_tuple(v):
    return tuple(int(x) for x in v.split('-')[0].split('.'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--version', default='4.2.3')
    ap.add_argument('--archive', help='use a local copy of the release .7z')
    args = ap.parse_args()

    archive = args.archive
    if not archive:
        url = (f'https://github.com/EmulatorJS/EmulatorJS/releases/download/'
               f'v{args.version}/{args.version}.7z')
        archive = os.path.join(tempfile.gettempdir(), f'emulatorjs-{args.version}.7z')
        if not os.path.exists(archive):
            print(f'downloading {url}')
            urllib.request.urlretrieve(url, archive)

    with py7zr.SevenZipFile(archive) as z:
        names = z.getnames()
    wanted = [n for n in names
              if n in KEEP or any(n.startswith(d) and n.endswith('.json') for d in KEEP_DIRS)]
    missing = [k for k in KEEP if k not in names]
    if missing:
        fail(f'the release does not contain {", ".join(missing)}')

    work = tempfile.mkdtemp()
    with py7zr.SevenZipFile(archive) as z:
        z.extract(path=work, targets=wanted)

    # The version the files say they are, not the one we asked for.
    with open(os.path.join(work, 'data/version.json')) as f:
        ejs_version = json.load(f)['version']

    # Patch the update check, and refuse to continue if it cannot be found.
    js_path = os.path.join(work, 'data/emulator.min.js')
    with open(js_path, encoding='utf-8') as f:
        js = f.read()
    count = js.count(UPDATE_CHECK)
    if count != 1:
        fail(f'expected the update check exactly once in emulator.min.js, '
             f'found it {count} times - this release needs the patch revisited')
    js = js.replace(UPDATE_CHECK, UPDATE_CHECK_OFF)
    with open(js_path, 'w', encoding='utf-8') as f:
        f.write(js)

    loader_path = os.path.join(work, 'data/loader.js')
    with open(loader_path, encoding='utf-8') as f:
        loader = f.read()
    for old, new in LOADER_PATCHES:
        count = loader.count(old)
        if count != 1:
            fail(f'expected `{old}` exactly once in loader.js, found it {count} '
                 'times - this release needs the patch revisited')
        loader = loader.replace(old, new)
    with open(loader_path, 'w', encoding='utf-8') as f:
        f.write(loader)

    # Check each core really is what the editor needs before shipping it.
    for core in ['smsplus-wasm.data', 'smsplus-legacy-wasm.data']:
        unpacked = tempfile.mkdtemp()
        with py7zr.SevenZipFile(os.path.join(work, 'data/cores', core)) as z:
            z.extractall(path=unpacked)
        meta = json.load(open(os.path.join(unpacked, 'core.json')))
        build = json.load(open(os.path.join(unpacked, 'build.json')))
        lacking = [e for e in REQUIRED_EXTENSIONS if e not in meta.get('extensions', [])]
        if lacking:
            fail(f'{core} does not handle .{", .".join(lacking)}')
        if version_tuple(build['minimumEJSVersion']) > version_tuple(ejs_version):
            fail(f'{core} needs EmulatorJS {build["minimumEJSVersion"]}, '
                 f'this release is {ejs_version}')
        if not any(n.endswith('.wasm') for n in os.listdir(unpacked)):
            fail(f'{core} contains no WebAssembly')
        shutil.rmtree(unpacked)

    # Lay it out under public/emulator/, flattening data/.
    if os.path.exists(DEST):
        shutil.rmtree(DEST)
    os.makedirs(DEST)
    for n in wanted:
        src = os.path.join(work, n)
        rel = 'LICENSE-EmulatorJS' if n == 'LICENSE' else n[len('data/'):]
        dst = os.path.join(DEST, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
    shutil.rmtree(work)

    # A manifest the test suite holds the folder to.
    lines = [f'EmulatorJS {ejs_version}, trimmed by tools/vendor-emulator.py',
             'Patched: the cdn.emulatorjs.org update check is disabled.',
             'Patched: loader.js loads the frontend once, not on every Play.', '']
    total = 0
    for root, _, files in os.walk(DEST):
        for name in sorted(files):
            if name == 'MANIFEST.txt':
                continue
            p = os.path.join(root, name)
            rel = os.path.relpath(p, DEST).replace(os.sep, '/')
            data = open(p, 'rb').read()
            total += len(data)
            lines.append(f'{hashlib.sha256(data).hexdigest()}  {rel}')
    with open(os.path.join(DEST, 'MANIFEST.txt'), 'w') as f:
        f.write('\n'.join(lines[:4] + sorted(lines[4:])) + '\n')

    print(f'EmulatorJS {ejs_version}: {len(wanted)} files, '
          f'{total / 1e6:.1f} MB, into public/emulator/')


if __name__ == '__main__':
    main()
