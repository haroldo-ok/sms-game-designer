/**
 * One emulator at a time.
 *
 * Pressing Play a second time opened a second emulator while the first kept
 * running. "Stopping" the first meant emptying its container, which removes
 * the picture and leaves the program: EmulatorJS's main loop, its audio, its
 * gamepad poll (a timer that reschedules itself every 10 ms) and its window
 * listeners all carried on, detached from the page.
 *
 * Two things make a correct stop harder than it looks.
 *
 * **EmulatorJS has no destroy.** Its own Exit button fires an `exit` event,
 * which stops the core's main loop and aborts the core a second later. That
 * is the shutdown the editor uses, plus the parts `exit` does not cover: the
 * gamepad poll, the audio context, and the element.
 *
 * **It is configured through globals and constructed asynchronously.**
 * loader.js reads `EJS_gameUrl` and friends after awaiting scripts and a
 * translation file, then assigns `window.EJS_emulator`. Press Play twice
 * quickly and the first loader is still in flight when the second starts -
 * so the first instance arrives *after* it was meant to have been stopped,
 * and nothing is holding it to stop it. It finishes loading and plays.
 *
 * So every instance is caught as it is constructed - `window.EJS_emulator`
 * is a property this module owns - and matched against the Play that asked
 * for it. One that arrives for a Play that has since been superseded or
 * stopped is shut down on arrival, before it can start. Both loaders read the
 * same globals when they construct, so it does not matter which arrival
 * belongs to which request: only the one that arrives for the latest live
 * Play is kept.
 *
 * Pure apart from the window it is given, so the race can be tested with a
 * stand-in window and stand-in emulators.
 */

/**
 * Shut an EmulatorJS instance down completely, whatever state it is in.
 *
 * @param {object} ejs an EmulatorJS instance
 */
export function stopEmulator(ejs) {
  if (!ejs || ejs.__smsgdStopped) return;
  ejs.__smsgdStopped = true;

  const halt = () => {
    // Stop emulating at once rather than a second from now.
    try {
      if (ejs.gameManager) ejs.gameManager.toggleMainLoop(0);
    } catch (e) {/* already stopped */}
    // EmulatorJS's own shutdown: flushes saves, stops the loop, and aborts
    // the core after a second.
    try {
      ejs.callEvent('exit');
    } catch (e) {/* nothing listening yet */}
    // Silence now; the abort would get there, eventually.
    try {
      const ctx = ejs.Module && ejs.Module.AL && ejs.Module.AL.currentCtx;
      if (ctx && ctx.audioCtx && ctx.audioCtx.state !== 'closed') ctx.audioCtx.close();
    } catch (e) {/* no audio */}
  };

  if (ejs.started) {
    halt();
  } else {
    // Still loading. Its pipeline - fetch the core, load it, fetch the game,
    // start - runs through these methods on the instance, so replacing them
    // with no-ops makes whichever step comes next the last. And should it
    // start anyway, it stops on the spot.
    ['downloadGameCore', 'initGameCore', 'initModule', 'downloadFiles', 'startGame']
        .forEach((m) => {
          try {
            ejs[m] = () => {};
          } catch (e) {/* read-only */}
        });
    try {
      ejs.on('start', halt);
    } catch (e) {/* no events */}
    halt();
  }

  try {
    if (ejs.gamepad) ejs.gamepad.terminate();
  } catch (e) {/* no gamepad handler */}
  try {
    if (ejs.elements && ejs.elements.parent) ejs.elements.parent.remove();
  } catch (e) {/* already gone */}
}

/**
 * Track which emulator belongs to which Play.
 *
 * @param {Window} win the window EmulatorJS assigns `EJS_emulator` on
 */
export function createSessions(win) {
  let seq = 0;
  let instance = null; // what window.EJS_emulator reads as
  let current = null; // {session, ejs} for the live emulator
  const pending = []; // sessions whose loader has not constructed yet
  const cancelled = new Set();

  Object.defineProperty(win, 'EJS_emulator', {
    configurable: true,
    get: () => instance,
    set: (ejs) => {
      instance = ejs;
      if (!ejs || typeof ejs !== 'object') return;
      const session = pending.shift();
      const stale = session === undefined || session !== seq || cancelled.has(session);
      if (stale) {
        stopEmulator(ejs);
        return;
      }
      ejs.__smsgdSession = session;
      current = {session, ejs};
    },
  });

  return {
    /** Begin a Play: stop whatever is running, and expect one new emulator. */
    begin() {
      if (current) {
        stopEmulator(current.ejs);
        current = null;
      }
      const session = ++seq;
      pending.push(session);
      return session;
    },

    /** End a Play, whether its emulator has arrived yet or not. */
    end(session) {
      cancelled.add(session);
      if (current && current.session === session) {
        stopEmulator(current.ejs);
        current = null;
      }
    },

    /** The loader for this session failed; it will never construct. */
    abandon(session) {
      const i = pending.indexOf(session);
      if (i >= 0) pending.splice(i, 1);
      cancelled.add(session);
    },

    get current() {
      return current && current.ejs;
    },
  };
}
