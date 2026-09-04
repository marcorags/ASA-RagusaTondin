import { aStarToNearest, dirTo } from '../core/pathfinding.js';

/**
 * Means-ends execution: perform ONE step toward the committed intention (the
 * timed control loop calls this once per cycle). Movement uses A* with a
 * `canMove` enriched by the belief store — remembered crates, other agents and
 * their predicted next cell, directional tiles.
 *
 * One step per cycle, rather than walking a whole path, is what keeps the
 * agent reactive: the world is re-sensed and the intention re-deliberated
 * between any two moves, so a stale plan can never outlive its assumptions.
 *
 * @typedef {import('../core/world.js').World} World
 * @typedef {import('./beliefs.js').BeliefStore} BeliefStore
 * @typedef {import('./deliberation.js').Option} Option
 */

/**
 * @param {World} world
 * @param {BeliefStore} beliefs
 * @param {{x:number,y:number}[]} targets
 * @returns {Promise<boolean>} true if an action was taken (awaited)
 */
async function moveStep(world, beliefs, targets) {
  const from = world.myTile();
  const canMove = world.makeCanMove(beliefs.blockedCells());
  const path = aStarToNearest(from, targets, canMove);
  if (!path || path.length < 2) return false; // no route right now
  const dir = dirTo(from, path[1]);
  if (!dir) return false;
  const res = await world.client.emitMove(dir);
  if (res) { world.me.x = res.x; world.me.y = res.y; }
  return true; // acted (even a failed move counts: it awaited, and A* replans next tick)
}

/**
 * Execute one step toward the committed intention.
 * @param {World} world
 * @param {BeliefStore} beliefs
 * @param {Option|null} committed
 * @returns {Promise<boolean>} true if an action was taken this tick
 */
export async function stepToward(world, beliefs, committed) {
  if (!committed) return false;
  const from = world.myTile();

  if (committed.type === 'go_pick_up') {
    if (from.x === committed.target.x && from.y === committed.target.y) {
      const grabbed = beliefs.parcelsAt(from);
      const picked = await world.client.emitPickup();
      if (picked && picked.length) {
        beliefs.onPickup(grabbed, picked.length);
        console.log(`[pickup] +${picked.length} @ ${from.x},${from.y} | carrying=${beliefs.carryingCount}`);
      }
      return true;
    }
    return moveStep(world, beliefs, [committed.target]);
  }

  if (committed.type === 'go_deliver') {
    if (world.deliveryTiles.some((d) => d.x === from.x && d.y === from.y)) {
      const dropped = await world.client.emitPutdown();
      if (dropped && dropped.length) {
        beliefs.onDeliver();
        console.log(`[deliver] +${dropped.length} | score=${world.me.score}`);
      }
      return true;
    }
    return moveStep(world, beliefs, world.deliveryTiles);
  }

  // Explore. A target we cannot route to is reported back to the belief store,
  // so the next deliberation rotates to another one instead of re-selecting
  // the same unreachable tile forever.
  const moved = await moveStep(world, beliefs, [committed.target]);
  if (!moved) beliefs.noteExploreFailed(committed.target);
  return moved;
}
