/**
 * Web Workers for jsdom, close enough to a browser to catch what matters.
 *
 * jsdom has no Worker. The end-to-end test therefore took the editor's
 * in-page fallback, and the built worker bundle was never executed by
 * anything - which is how a worker that could not load its own code chunk
 * shipped: it asked for `js/js/755…js`, because a worker resolves
 * `importScripts` against *its own* URL, not the page's, and the editor's
 * relative publicPath was written for the page.
 *
 * This runs the real file from dist/ in a separate V8 context and applies
 * the browser's rules where they matter:
 *
 *   - `importScripts` resolves against the worker script's URL, loads
 *     synchronously, and throws a NetworkError for anything missing - the
 *     exact message the browser gave;
 *   - an exception escaping the worker's startup is reported to the page as
 *     an `error` event, not thrown into the page;
 *   - messages are delivered asynchronously, and cloned on the way.
 *
 * It does not pretend to isolate threads; it only has to make the bundle's
 * own assumptions about URLs and startup either hold or fail visibly.
 */

import vm from 'vm';

/**
 * @param {Window} w the jsdom window to install into
 * @param {(url: URL) => Buffer|null} load serves a URL, or null for a 404
 * @returns {{created: string[], errors: string[]}} what happened, for tests
 */
export function installWorker(w, load) {
  const log = {created: [], errors: []};

  class EmulatedWorker {
    constructor(url) {
      const href = new URL(String(url), w.location.href).href;
      log.created.push(href);
      this.onmessage = null;
      this.onerror = null;
      this.listeners = {message: [], error: []};

      const ctx = vm.createContext({
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        queueMicrotask, TextEncoder, TextDecoder, URL, performance,
        WebAssembly, Response,
      });
      ctx.self = ctx;
      ctx.globalThis = ctx;
      ctx.location = new URL(href);

      // importScripts: synchronous, resolved against the worker's own URL.
      ctx.importScripts = (...urls) => {
        for (const u of urls) {
          const abs = new URL(String(u), href);
          const code = load(abs);
          if (!code) {
            throw new Error(`NetworkError: Failed to execute 'importScripts' on ` +
              `'WorkerGlobalScope': The script at '${abs.href}' failed to load.`);
          }
          vm.runInContext(code.toString('utf8'), ctx, {filename: abs.href});
        }
      };

      ctx.fetch = async (u) => {
        const abs = new URL(String(u), href);
        const body = load(abs);
        if (!body) return {ok: false, status: 404};
        return {
          ok: true, status: 200,
          text: async () => body.toString('utf8'),
          arrayBuffer: async () =>
            body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
        };
      };

      // Worker -> page.
      ctx.postMessage = (data) => {
        const copy = structuredClone(data);
        setTimeout(() => this.dispatch('message', {data: copy}), 0);
      };

      const fail = (e) => {
        const message = `Uncaught ${(e && e.message) || e}`;
        log.errors.push(message);
        setTimeout(() => this.dispatch('error', {message, error: e}), 0);
      };
      this.ctx = ctx;
      this.fail = fail;

      const code = load(new URL(href));
      if (!code) {
        fail(new Error(`NetworkError: failed to load worker script ${href}`));
        return;
      }
      try {
        vm.runInContext(code.toString('utf8'), ctx, {filename: href});
      } catch (e) {
        fail(e);
      }
    }

    dispatch(type, ev) {
      const own = type === 'message' ? this.onmessage : this.onerror;
      if (own) own.call(this, ev);
      this.listeners[type].forEach((fn) => fn.call(this, ev));
    }

    addEventListener(type, fn) {
      if (this.listeners[type]) this.listeners[type].push(fn);
    }

    // Page -> worker.
    postMessage(data) {
      const copy = structuredClone(data);
      setTimeout(() => {
        const handler = this.ctx.onmessage;
        if (!handler) return;
        try {
          const r = handler.call(this.ctx, {data: copy});
          if (r && typeof r.catch === 'function') r.catch(this.fail);
        } catch (e) {
          this.fail(e);
        }
      }, 0);
    }

    terminate() {
      this.ctx.onmessage = null;
    }
  }

  w.Worker = EmulatedWorker;
  return log;
}
