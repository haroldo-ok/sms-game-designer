/**
 * Mapping a compiler error back to the block that caused it.
 *
 * `ERROR: at line 412: Bad syntax` is useless to someone who has never seen
 * the file it is talking about. The chain back to the block is cheap and it
 * already exists end to end:
 *
 *   block id  ->  .bas line   (the ' @blk: comment codegen emits)
 *             ->  .asm line   (CVBasic copies each source line in as a comment)
 *             ->  ROM address (gasm80's listing)
 *
 * so walking back from the reported line to the nearest preceding marker
 * names the block. A line with no marker above it is, by construction, inside
 * the engine or the generator - a bug in the tool, not in the user's game,
 * and it says so rather than leaving someone to conclude they are bad at
 * this.
 *
 * This lives apart from the Vue hook that uses it because the hook imports
 * the composition API and webpack's raw-loader, which makes it unloadable
 * outside a browser build - and this is precisely the part worth testing.
 */

/**
 * @param {object} res    the worker result: {error, stderr, stage}
 * @param {Array}  lineMap  [{line, blockId}] from generateProgram
 * @returns {{blockId?: string, line?: number, internal?: boolean,
 *            message: string, stage?: string}}
 */
export function blame(res, lineMap) {
  const text = `${(res && res.error) || ''}\n${(res && res.stderr) || ''}`;
  const m = /at line (\d+)/.exec(text);
  if (!m) {
    return {
      internal: true,
      stage: res && res.stage,
      message: (res && res.error) || 'The build failed.',
    };
  }
  const line = +m[1];

  let best = null;
  (lineMap || []).forEach((e) => {
    if (e.line <= line && (!best || e.line > best.line)) best = e;
  });

  if (!best) {
    return {
      internal: true,
      stage: res && res.stage,
      message: 'Something in the engine or the code generator failed to ' +
        'compile. This is a bug in the tool, not a problem with your game.',
      detail: res && res.error,
      line,
    };
  }
  return {blockId: best.blockId, line, message: (res && res.error) || 'Build failed.'};
}

/**
 * The same judgement, for the assembler.
 *
 * Neither tool can be trusted to exit non-zero: CVBasic returns 0 for some
 * errors, and gasm80 returns 0 for an undefined label while still writing a
 * full-size ROM. Anything that reads an exit status ships a corrupt
 * cartridge, so both stages are judged on what they printed.
 */
export function failed(stage, exitCode, output) {
  if (exitCode) return true;
  const text = String(output || '');
  // Case-insensitively, and for both tools: CVBasic prints "ERROR:" while
  // gasm80 prints "Error:", so a single-case check silently passes half of
  // all failures through as successes.
  return /(^|\s)error[: ]/i.test(text);
}
