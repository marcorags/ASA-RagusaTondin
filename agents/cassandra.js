import { connectWorld, sleep } from '../core/world.js';
import { resolveStrategy } from '../bdi/strategy.js';
import { BeliefStore } from '../bdi/beliefs.js';
import { generateOptions, reviseIntention } from '../bdi/deliberation.js';
import { stepToward } from '../bdi/plans.js';

/**
 * AGENT A — "Cassandra", the BDI agent.
 *
 * A timed control loop that makes the BDI cycle explicit, one step per tick:
 *
 *   revise beliefs → generate options → rank by utility → cautious intention
 *   revision → execute one step
 *
 * The loop is TIMED rather than event-driven on purpose. Reacting to every
 * sensing event means re-deliberating dozens of times per second on a world
 * that has barely changed, and it puts the decision rate at the mercy of the
 * server's event rate; a clock-paced loop keeps deliberation and action under
 * our own control, which is what makes the agent's behaviour reproducible.
 *
 * What each piece contributes:
 *   - beliefs.js      belief revision with memory, aging and reward decay, so
 *                     the agent reasons about a world larger than its sensing;
 *   - deliberation.js options ranked by NET expected reward (decay and
 *                     opponent risk subtracted), and CAUTIOUS reconsideration
 *                     with a margin δ, which is what stops the agent from
 *                     oscillating between two nearly-equal parcels;
 *   - plans.js        means-ends execution: A* plus the primitive action;
 *   - strategy.js     profiles and feature flags, so behaviour can be varied
 *                     one lever at a time.
 *
 * This is the agent validated on the Challenge 1 scenarios, and the baseline
 * that Logical_Cassandra extends with a PDDL planner.
 */

const world = await connectWorld('Cassandra');
const params = resolveStrategy(world.config);
const beliefs = new BeliefStore(world, params);

/** @type {import('../bdi/deliberation.js').Option|null} */
let committed = null;

console.log(`[start] "Cassandra" profile=${params.profile} | delivery=${world.deliveryTiles.length} capacity=${world.capacity} decayMs=${params.decayMs} obs=${params.obs} margin=${params.reconsiderMargin}`);

// Timed BDI control loop. Each iteration re-deliberates on fresh beliefs and
// performs one action; when there is nothing to do it sleeps one tick.
while (true) {
  beliefs.revise();
  const options = generateOptions(beliefs, world, params);
  const next = reviseIntention(committed, options, params);
  const prevKey = committed ? committed.key : 'none';
  if (params.debug && (next ? next.key : 'none') !== prevKey) {
    console.log(`[debug] intention: ${prevKey} → ${next ? `${next.key} (u=${next.u.toFixed(1)})` : 'none'} | ${options.length} options`);
  }
  committed = next;
  const acted = await stepToward(world, beliefs, committed);
  if (!acted) await sleep(params.tick);
}
