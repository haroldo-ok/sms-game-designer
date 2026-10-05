/**
 * The example projects offered from the editor's Open menu.
 *
 * Each is loaded on demand, so none of them costs anything until it is
 * picked: webpack gives every dynamic import its own chunk.
 *
 * These are the same files the regression suite builds and playtests on the
 * emulated hardware, so an example that is offered is an example known to
 * build and play. They are stored as lowered programs rather than Blockly
 * XML; the editor rebuilds the blocks when a script is opened, and a test
 * holds every one of them to an exact round trip so that what you see is
 * precisely the game.
 */
export const EXAMPLES = [
  {
    id: 'shmup',
    title: 'Bug Blaster',
    console: 'Master System',
    blurb: 'A shooter: eight-way ship, two waves of bugs that fire back, ' +
      'explosions, score and lives.',
    load: () => import(/* webpackChunkName: "example-shmup" */
        '../../examples/shmup.json'),
  },
  {
    id: 'platformer',
    title: 'Cavern Run',
    console: 'Master System',
    blurb: 'A platformer: painted tile terrain, gravity and jumping, ' +
      'spikes, coins, and two caverns to clear.',
    load: () => import(/* webpackChunkName: "example-platformer" */
        '../../examples/platformer.json'),
  },
  {
    id: 'shmup-sg1000',
    title: 'Bug Blaster SG',
    console: 'SG-1000',
    blurb: 'The same shooter on the SG-1000: the same project, with the ' +
      'counts brought inside the smaller machine.',
    load: () => import(/* webpackChunkName: "example-sg1000" */
        '../../examples/shmup-sg1000.json'),
  },
];

/** Fetch an example's project data, whatever shape the bundler hands back. */
export async function loadExample(example) {
  const mod = await example.load();
  return mod && mod.default ? mod.default : mod;
}
