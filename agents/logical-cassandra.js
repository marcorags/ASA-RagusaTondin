import { connectWorld, sleep } from '../core/world.js';
import { resolveStrategy } from '../bdi/strategy.js';
import { BeliefStore } from '../bdi/beliefs.js';
import { generateOptions, reviseIntention, clearlyBetter } from '../bdi/deliberation.js';
import { stepToward } from '../bdi/plans.js';
import { planRoute } from '../bdi/pddl.js';

/** @typedef {import('../bdi/pddl.js').Step} Step */

const world = await connectWorld('Logical_Cassandra');
const params = resolveStrategy(world.config);
const beliefs = new BeliefStore(world, params);

console.log(`[start] "Logical_Cassandra" profile=${params.profile} | delivery=${world.deliveryTiles.length} capacity=${world.capacity}`);

/**
 * Execute one primitive step of a PDDL plan.
 * @param {Step} step
 * @returns {Promise<boolean>} false if a move failed (⇒ drop the plan and replan)
 */
async function execStep(step) {
  const from = world.myTile();
  if (step.kind === 'move') {
    const res = await world.client.emitMove(step.dir);
    if (res) { world.me.x = res.x; world.me.y = res.y; return true; }
    return false;
  }
  if (step.kind === 'pickup') {
    const grabbed = beliefs.parcelsAt(from);
    const picked = await world.client.emitPickup();
    if (picked && picked.length) {
      beliefs.onPickup(grabbed, picked.length);
      console.log(`[pddl:pickup] +${picked.length} @ ${from.x},${from.y} | carrying=${beliefs.carryingCount}`);
    }
    return true;
  }
  const dropped = await world.client.emitPutdown();
  if (dropped && dropped.length) {
    beliefs.onDeliver();
    console.log(`[pddl:deliver] +${dropped.length} | score=${world.me.score}`);
  }
  return true;
}

/** Steps between two reviews of a running plan (a review costs one deliberation). */
const PLAN_REVIEW_EVERY = 8;
/** Slack over a plan's nominal duration before it is considered stale. */
const PLAN_TIME_SLACK = 2;

/** @type {Step[]} */
let plan = [];
/** Parcels the running plan was built to collect — its premises. @type {Set<string>} */
let planParcels = new Set();
/** Wall-clock budget of the running plan. */
let planDeadline = 0;
let stepsSinceReview = 0;
let cooldownUntil = 0;
/** @type {import('../bdi/deliberation.js').Option|null} committed intention for the greedy fallback */
let greedyCommitted = null;

/**
 * Is the running plan still worth finishing?
 *
 * A symbolic plan is computed once and executed over many ticks, during which
 * the world does not hold still: parcels decay, rivals take them, better ones
 * appear. Executing to the last step regardless would make the planner a
 * blindfold — the agent would be committed to a route whose reasons have
 * expired. So the plan is treated as an intention and reconsidered like one,
 * against the same margin δ the greedy deliberation uses.
 *
 * Two ways a plan stops being worth it:
 *  - its premises are gone. Every parcel it was built around has been taken or
 *    has decayed away, and we are carrying nothing, so finishing the route
 *    would deliver nothing;
 *  - something better appeared. The best pickup OUTSIDE the plan now beats the
 *    best one still INSIDE it, clearly. Both figures come from the same option
 *    generator, so they are directly comparable — which is precisely why the
 *    comparison is made on utilities and not on raw rewards.
 *
 * @returns {boolean}
 */
function planStillWorthwhile() {
  const alive = [...planParcels].filter((id) => beliefs.parcels.has(id));
  if (alive.length === 0 && beliefs.carryingCount === 0) return false;
  const options = generateOptions(beliefs, world, params);
  const inside = options.find((o) => o.type === 'go_pick_up' && o.id && planParcels.has(o.id));
  const outside = options.find((o) => o.type === 'go_pick_up' && o.id && !planParcels.has(o.id));
  if (!inside || !outside) return true;
  return !clearlyBetter(outside, inside, params);
}

while (true) {
  beliefs.revise();

  if (plan.length) {
    const stale = Date.now() > planDeadline;
    if (stale || ++stepsSinceReview >= PLAN_REVIEW_EVERY) {
      stepsSinceReview = 0;
      if (stale || !planStillWorthwhile()) {
        console.log(`[pddl] plan dropped after ${plan.length} remaining step(s): ${stale ? 'time budget exhausted' : 'premises no longer hold'} → re-deliberating`);
        plan = [];
        planParcels = new Set();
        continue;
      }
    }
    const step = /** @type {Step} */ (plan.shift());
    const ok = await execStep(step);
    if (!ok) plan = []; // a move failed → drop the plan and replan next tick
    continue;
  }

  if (Date.now() >= cooldownUntil) {
    const r = await planRoute(world, beliefs, params);
    if (r.status === 'ok' && r.steps.length) {
      plan = r.steps;
      planParcels = new Set(r.parcelIds);
      planDeadline = Date.now() + plan.length * params.moveMs * PLAN_TIME_SLACK;
      stepsSinceReview = 0;
      console.log(`[pddl] plan with ${plan.length} steps for ${planParcels.size} parcel(s), budget ${Math.round((planDeadline - Date.now()) / 1000)}s`);
      continue;
    }
    if (r.status === 'fail') {
      cooldownUntil = Date.now() + 5000; // don't hammer the solver on failure
      console.log('[pddl] no plan → greedy fallback (cooldown 5s)');
    }
  }

  const options = generateOptions(beliefs, world, params);
  greedyCommitted = reviseIntention(greedyCommitted, options, params);
  const acted = await stepToward(world, beliefs, greedyCommitted);
  if (!acted) await sleep(params.tick);
}
