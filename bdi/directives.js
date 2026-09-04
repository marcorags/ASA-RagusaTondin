import { BeliefStore } from './beliefs.js';

/**
 * Directives — persistent, DECLARATIVE game-strategy modifiers compiled from
 * natural-language missions.
 *
 * This is how a mission that changes the RULES of play (rather than asking for
 * a one-off action) reaches the agent's behaviour. The LLM head interprets the
 * message ONCE and writes a directive here; from then on both team bodies
 * consume it at clock speed with ZERO LLM involvement. That split is also the
 * safety property, in the spirit of CaMeL-style control/data separation: a
 * constraint that lives in code cannot be talked out of by the language
 * channel, however the incoming text is phrased.
 *
 * Three families, in increasing depth of intervention: forbidden tiles (a
 * pathfinding constraint), batch size (a deliberation constraint), and a
 * delivery value cap (which inverts the value of time — see applyDirectives).
 */
export class Directives {
  constructor() {
    /** @type {Set<string>} "x_y" keys the agent must never step on */
    this.forbiddenTiles = new Set();
    /** @type {number|null} deliver EXACTLY this many parcels at a time */
    this.batchSize = null;
    /** @type {number|null} bonus applies to deliveries whose total reward ≤ threshold */
    this.deliverValueMax = null;
    /** @type {boolean} stop-go mode armed: RED/GREEN messages gate movement */
    this.stopGoArmed = false;
    /** @type {boolean} movement gate — true = FREEZE (red light); flipped at reflex speed */
    this.halt = false;
  }

  /** @param {{x:number,y:number}[]} tiles */
  addForbidden(tiles) {
    for (const t of tiles) this.forbiddenTiles.add(`${t.x}_${t.y}`);
  }

  /** One-line state for logs and get_state (the model must see active constraints). */
  describe() {
    const parts = [];
    if (this.forbiddenTiles.size) parts.push(`forbidden:${this.forbiddenTiles.size} tiles`);
    if (this.batchSize) parts.push(`batchSize:${this.batchSize}`);
    if (this.deliverValueMax !== null) parts.push(`deliverValueMax:${this.deliverValueMax}`);
    if (this.stopGoArmed) parts.push(`stopGo:${this.halt ? 'RED(halt)' : 'GREEN'}`);
    return parts.length ? parts.join(' ') : 'none';
  }
}

/**
 * Fold the BEHAVIOURAL directives into the body's option menu — a pure
 * post-filter on `generateOptions` output, so the deliberation module itself
 * stays untouched (the same non-fork principle as DirectiveAwareBeliefs,
 * applied to deliberation instead of pathfinding):
 *
 *  - batchSize B: pickups only while carrying < B; deliver only at EXACTLY B
 *    (the mission agent rewards exact batches — 4 is as wrong as 2);
 *  - deliverValueMax T: one parcel at a time, preferring the LOWEST-value one
 *    (≤T is deliverable immediately); when the carried value still exceeds T,
 *    the putdown is GATED and the agent walks to the nearest delivery and
 *    waits there — reward decay, normally our enemy, becomes the tool that
 *    brings the cargo under threshold (the mission inverts the value of time,
 *    the directive layer makes the body exploit it).
 *
 * @param {import('./deliberation.js').Option[]} options
 * @param {import('./beliefs.js').BeliefStore} beliefs
 * @param {Directives} directives
 * @param {import('../core/world.js').World} world
 * @returns {import('./deliberation.js').Option[]}
 */
export function applyDirectives(options, beliefs, directives, world) {
  let out = options;

  if (directives.batchSize) {
    const B = directives.batchSize;
    const c = beliefs.carryingCount;
    out = out.filter((o) =>
      o.type === 'go_deliver' ? c >= B
      : o.type === 'go_pick_up' ? c < B
      : true);
  }

  if (directives.deliverValueMax !== null) {
    const T = directives.deliverValueMax;
    const c = beliefs.carryingCount;
    if (c === 0) {
      // One parcel at a time, the LOWEST-value candidate first.
      const est = new Map(beliefs.freeParcels().map((p) => [p.id, p.est]));
      const picks = out.filter((o) => o.type === 'go_pick_up');
      if (picks.length > 0) {
        const lowest = picks.reduce((a, b) => ((est.get(a.id ?? '') ?? Infinity) <= (est.get(b.id ?? '') ?? Infinity) ? a : b));
        out = [lowest, ...out.filter((o) => o.type === 'explore')];
      }
    } else {
      out = out.filter((o) => o.type !== 'go_pick_up'); // never stack under a value cap
      // SAFETY margin of 2, measured live: our carried-value ESTIMATE can lag
      // the server's truth by 1-2 points, and half the deliveries were missing
      // the bonus by exactly that much. Parking ~2s longer per cycle is far
      // cheaper than a missed bonus.
      if (beliefs.carriedValue() > T - 2) {
        // Gate the putdown: park on/near a delivery while the cargo decays to ≤ T.
        out = out.filter((o) => o.type !== 'go_deliver');
        const from = world.myTile();
        /** @param {{x:number,y:number}} d */
        const dist = (d) => Math.abs(d.x - from.x) + Math.abs(d.y - from.y);
        const nearest = world.deliveryTiles.length
          ? world.deliveryTiles.reduce((a, b) => (dist(a) <= dist(b) ? a : b))
          : null;
        if (nearest) out = [{ key: 'valuemax:park', type: 'explore', target: nearest, u: 0.5 }, ...out];
      }
    }
  }

  return out.sort((a, b) => b.u - a.u);
}

/**
 * BeliefStore that folds the directives into the pathfinding picture: a
 * forbidden tile is a permanently blocked cell, so A* routes around it BY
 * CONSTRUCTION — no per-step checks scattered anywhere else, and the body
 * modules (deliberation/plans) stay untouched.
 */
export class DirectiveAwareBeliefs extends BeliefStore {
  /**
   * @param {import('../core/world.js').World} world
   * @param {import('./strategy.js').Params} params
   * @param {Directives} directives
   */
  constructor(world, params, directives) {
    super(world, params);
    this.directives = directives;
  }

  blockedCells() {
    const b = super.blockedCells();
    for (const key of this.directives.forbiddenTiles) b.add(key);
    return b;
  }
}
