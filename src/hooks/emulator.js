/**
 * The emulator, and what you get for free by owning it.
 *
 * EmulatorJS, with the same target-to-core mapping `CVBasic-emscripten`
 * already proved out: one core covers SMS, SG-1000 and (later) Mega Drive,
 * so adding a Genesis backend would not change the player layer at all.
 *
 * The Master System needs no BIOS, which is the main reason it is the
 * flagship target rather than the ColecoVision: Play is one fetch lighter
 * and one caveat shorter. Coleco still works, it just has to be told about
 * the BIOS first.
 *
 * The interesting part is the second half of this file. Because the tool
 * controls the emulator *and* has gasm80's symbol file, it can read the
 * entity pool straight out of emulator RAM every frame. For a no-code tool,
 * "see your invisible hitboxes on the running game" is worth more than any
 * amount of text output.
 */

import {ref} from '@vue/composition-api';
import {TARGETS} from '../ir/schema.js';
import {createSessions} from './emulator-session.js';

// Created on first use, because it installs a property on window.
let sessions = null;
const getSessions = () => sessions || (sessions = createSessions(window));

export const running = ref(false);
export const emulatorError = ref(null);

/**
 * EmulatorJS, bundled with the editor rather than fetched from a CDN.
 *
 * It used to load `@emulatorjs/emulatorjs@latest` from jsdelivr: a network
 * dependency on every Play, and an unpinned one, so the emulator could change
 * underneath the editor at any time. public/emulator/ now holds release 4.2.3
 * trimmed to what these consoles need - the frontend, the decompressors, the
 * translations, and the smsplus core in its WebGL 2 and legacy builds. The
 * release's other 185 cores and its threaded builds are left out: 2.9 MB
 * instead of 303.
 *
 * Resolved against the page, like the compilers, so a copy hosted in a
 * subdirectory finds it.
 */
function emulatorBase() {
  return new URL('emulator/', document.baseURI).href;
}

/**
 * @param {HTMLElement} host
 * @param {Uint8Array} rom
 * @param {string} targetId
 */
export function play(host, rom, targetId) {
  const target = TARGETS[targetId] || TARGETS.sms;
  emulatorError.value = null;

  // Before anything else: whatever was playing stops now, completely - and
  // an emulator still loading for an earlier Play will be stopped the moment
  // it arrives. See emulator-session.js.
  const session = getSessions().begin();

  // Only the Master System core is bundled. EmulatorJS would otherwise reach
  // for the missing ColecoVision or MSX core on its own CDN, quietly - which
  // works online, fails offline, and says nothing either way.
  if (!target.bundledEmulator) {
    emulatorError.value =
      `Playing ${target.label} games inside the editor is not supported yet. ` +
      'Your game built correctly: download the ROM and run it in a ' +
      `${target.label} emulator${target.needsBios ? ' (it will need a BIOS image)' : ''}.`;
    getSessions().abandon(session);
    host.innerHTML = '';
    return () => {};
  }

  // A fresh container each time: EmulatorJS keeps a lot of global state and
  // reusing one across builds is the quickest way to end up debugging the
  // emulator instead of the game.
  host.innerHTML = '<div id="game"></div>';

  // Everything from here can fail for reasons outside the editor - no
  // network, a blocked script, a browser missing an API - and the ROM is
  // good regardless. A failure has to land in emulatorError, where the Play
  // tab shows it next to the Download button; an exception thrown out of
  // here used to leave a silent black rectangle instead.
  let url = null;
  try {
    url = URL.createObjectURL(new Blob([rom], {type: 'application/octet-stream'}));
  } catch (e) {
    emulatorError.value = `The emulator could not be started (${e.message}).`;
    getSessions().abandon(session);
    running.value = false;
    return () => {
      host.innerHTML = '';
    };
  }

  window.EJS_player = '#game';
  window.EJS_core = target.emulatorCore;
  window.EJS_gameUrl = url;
  window.EJS_pathtodata = emulatorBase();
  // Threaded builds are not bundled, so never ask for one - even on a host
  // that is cross-origin isolated and would otherwise allow them.
  window.EJS_threads = false;
  window.EJS_startOnLoaded = true;
  // With an extension, so the core can tell an SG-1000 image from a Master
  // System one - a blob URL carries no file name of its own.
  window.EJS_gameName = `game.${target.romExt}`;
  if (target.needsBios) {
    // The one target where Play has to ask the user for a file first.
    window.EJS_biosUrl = window.SMSGD_BIOS_URL || '';
  }

  const script = document.createElement('script');
  script.src = `${emulatorBase()}loader.js`;
  // The loader has done its job once it has run; leaving one tag per Play
  // in the page is how they piled up.
  script.onload = () => script.remove();
  script.onerror = () => {
    getSessions().abandon(session);
    script.remove();
    emulatorError.value =
      'The emulator could not be loaded. Your game built correctly: use ' +
      'Download ROM and run it in any emulator, or on real hardware.';
    running.value = false;
  };
  document.body.appendChild(script);
  running.value = true;

  return () => {
    getSessions().end(session);
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Nothing to release.
    }
    host.innerHTML = '';
    running.value = false;
  };
}

/* ------------------------------------------------------------------ */
/* live inspection                                                     */
/* ------------------------------------------------------------------ */

/**
 * Because the tool owns the emulator *and* has gasm80's symbol file, it can
 * read the entity pool straight out of emulator RAM every frame and draw
 * hitboxes over the running game. For a no-code tool that is worth more than
 * any amount of text output.
 *
 * The parsing lives in generators/symbols.js so it can be tested outside a
 * browser build - which is how it was found to match nothing at all.
 */
export {
  parseSymbols, readPool, buildProcRanges, attributeSamples,
} from '../generators/symbols.js';
