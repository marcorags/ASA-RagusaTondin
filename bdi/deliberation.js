/**
 * @typedef {import('../core/world.js').World} World
 * @typedef {import('./strategy.js').Params} Params
 * @typedef {import('./beliefs.js').BeliefStore} BeliefStore
 * @typedef {{ key:string, type:'go_pick_up'|'go_deliver'|'explore', target:{x:number,y:number}, id?:string, u:number }} Option
 */

/**
 * Softness of the race model, in tiles. A rival this much closer to a parcel
 * than we are is given roughly a 73% chance of reaching it first; the odds
 * approach 0 and 1 smoothly on either side, and are exactly even at a tie.
 */
const RACE_SOFTNESS = 2;

/** @param {{x:number,y:number}} a @param {{x:number,y:number}} b */
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
/** @param {{x:number,y:number}} from @param {{x:number,y:number}[]} tiles */
const nearest = (from, tiles) => tiles.reduce((m, t) => Math.min(m, manhattan(from, t)), Number.POSITIVE_INFINITY);

/**
 * Generate and rank options by utility (net expected reward − risk).
 * @param {BeliefStore} beliefs
 * @param {World} world
 * @param {Params} params
 * @returns {Option[]}
 */
export function generateOptions(beliefs, world, params) {
  const from = world.myTile();
  const deliv = world.deliveryTiles;
  const decayPerStep = Number.isFinite(params.decayMs) ? params.moveMs / params.decayMs : 0;
  /** @type {Option[]} */
  const options = [];

  if (beliefs.carryingCount < world.capacity && (params.batching || beliefs.carryingCount === 0)) {
    const rivals = params.opponentPrediction ? beliefs.agentList() : [];
    const dDeliv = deliv.length ? nearest(from, deliv) : 0;
    const carrying = beliefs.carryingCount;
    for (const p of beliefs.freeParcels()) {
      const dMe = manhattan(from, p);
      const dPD = deliv.length ? nearest(p, deliv) : 0;
      const rewardAtDeliv = beliefs.estReward(p, (dMe + dPD) * params.moveMs);
      // Opponent risk: the expected reward is discounted by the probability of
      // LOSING the race for this parcel. The probability is a smooth function
      // of the distance gap rather than a verdict on who is nearer, because
      // rival positions are believed, not known: they are sensed with noise,
      // remembered while out of sight, and extrapolated one step ahead. A
      // step-shaped risk would let a rival drifting across the tie line wipe
      // out or restore the whole reward from one tick to the next, and an
      // agent whose utilities jump like that cannot hold an intention.
      let pLose = 0;
      for (const a of rivals) {
        const gap = manhattan(a, p) - dMe;                       // > 0 ⇒ we are closer
        pLose = Math.max(pLose, 1 / (1 + Math.exp(gap / RACE_SOFTNESS)));
      }
      const risk = rewardAtDeliv * pLose;
      // When already carrying, the real cost of grabbing p is the DETOUR (extra
      // steps vs going straight to a delivery) times the decay of the whole
      // load. This makes en-route batching worthwhile but long detours not.
      const detour = carrying > 0 ? Math.max(0, (dMe + dPD) - dDeliv) : dMe;
      const loadDecay = carrying > 0 ? detour * decayPerStep * carrying : 0;
      const u = rewardAtDeliv - loadDecay - params.distTiebreak * detour - risk;
      options.push({ key: `pick:${p.id}`, type: 'go_pick_up', target: { x: p.x, y: p.y }, id: p.id, u });
    }
  }

  if (beliefs.carryingCount > 0 && deliv.length) {
    const u = 1 + params.distTiebreak * beliefs.carryingCount;
    options.push({ key: 'deliver', type: 'go_deliver', target: deliv[0], u });
  }

  const exp = beliefs.exploreTarget();
  if (exp) options.push({ key: 'explore', type: 'explore', target: exp, u: 0.001 });

  options.sort((a, b) => b.u - a.u);
  return options;
}

/**
 * Does `challenger` beat `incumbent` by more than the reconsideration margin δ?
 *
 * This is the hysteresis that keeps commitment from collapsing into constant
 * re-evaluation, and it is stated as an ABSOLUTE advantage measured against
 * the scale of the two options being compared. Expressing δ as a percentage of
 * the incumbent's utility would be simpler but wrong twice over: utilities here
 * are signed (a parcel a rival will almost certainly reach first is worth less
 * than nothing to chase) and can be arbitrarily close to zero (exploration
 * carries a deliberately negligible baseline). A percentage of a negative
 * number LOWERS the bar to abandon it, and a percentage of ~0 removes the bar
 * altogether — in both cases the margin would encourage exactly the
 * oscillation it exists to prevent.
 *
 * The scale is floored at 1 so that comparisons between two near-zero options
 * still need a real difference to flip the commitment.
 *
 * @param {Option} challenger
 * @param {Option} incumbent
 * @param {Params} params
 * @returns {boolean}
 */
export function clearlyBetter(challenger, incumbent, params) {
  const scale = Math.max(Math.abs(incumbent.u), Math.abs(challenger.u), 1);
  return challenger.u - incumbent.u > params.reconsiderMargin * scale;
}

/**
 * Cautious intention revision: keep the committed intention unless it becomes
 * invalid or a new option beats it clearly.
 * @param {Option|null} committed
 * @param {Option[]} options
 * @param {Params} params
 * @returns {Option|null}
 */
export function reviseIntention(committed, options, params) {
  if (options.length === 0) return null;
  const best = options[0];
  if (!committed) return best;
  const current = options.find((o) => o.key === committed.key);
  if (!current) return best;                                   // committed no longer valid → switch
  if (clearlyBetter(best, current, params)) return best;       // clearly better → switch
  return current;                                              // keep commitment (target refreshed)
}
