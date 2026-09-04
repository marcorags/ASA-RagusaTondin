/**
 * BeliefStore: belief revision over the raw percept — current sensing, plus
 * MEMORY (what we saw and no longer see) and AGING (how much we still trust
 * it). Sensing is local, so the percept alone is not a world model: parcels
 * and agents that leave the sensing radius must be remembered, their value
 * must be decayed as the server decays it, and they must be forgotten on
 * EVIDENCE (we look at the tile and it is empty) rather than on a timer.
 *
 * @typedef {import('../core/world.js').World} World
 * @typedef {import('./strategy.js').Params} Params
 * @typedef {{ id:string, x:number, y:number, reward0:number, seenAt:number }} ParcelBelief
 * @typedef {{ id:string, x:number, y:number, seenAt:number, dir:{dx:number,dy:number} }} AgentBelief
 */

/** @param {{x:number,y:number}} a @param {{x:number,y:number}} b */
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export class BeliefStore {
  /**
   * @param {World} world
   * @param {Params} params
   */
  constructor(world, params) {
    this.world = world;
    this.p = params;
    /** @type {Map<string, ParcelBelief>} */
    this.parcels = new Map();
    /** @type {Map<string, AgentBelief>} */
    this.agents = new Map();
    /** @type {Map<string, {x:number,y:number}>} remembered crate cells */
    this.crates = new Map();
    /** @type {Map<string, {reward0:number, seenAt:number}>} parcels we carry */
    this.carrying = new Map();
    /** counter for synthetic ids of carried parcels not present in beliefs */
    this._unk = 0;
    /** @type {{x:number,y:number}|null} roaming target for spawner-less maps */
    this._roam = null;
    /** @type {Map<string, number>} last time each spawner was within view */
    this.spawnerSeen = new Map(world.spawnerTiles.map((s) => [`${s.x}_${s.y}`, 0]));
  }

  get me() { return this.world.me; }
  get carryingCount() { return this.carrying.size; }

  /**
   * Estimated current reward of a parcel belief, optionally after `extraMs` of travel.
   * (The server decreases a parcel's reward by 1 every `decayMs`.)
   * @param {{reward0:number, seenAt:number}} pb
   * @param {number} [extraMs]
   */
  estReward(pb, extraMs = 0) {
    // `aging` off (ECO): use the reward as last seen — cheaper and simpler,
    // deliberately less accurate (the ablation lever the profiles promise).
    if (!this.p.aging || !Number.isFinite(this.p.decayMs)) return pb.reward0;
    const age = (Date.now() - pb.seenAt) + extraMs;
    return Math.max(0, pb.reward0 - Math.floor(age / this.p.decayMs));
  }

  /** Belief revision: ingest the latest percept, age/prune, infer directions. */
  revise() {
    const now = Date.now();
    const here = this.world.myTile();

    const sensed = this.world.getParcels();
    const sensedIds = new Set(sensed.map((p) => p.id));
    for (const p of sensed) {
      if (p.carriedBy) { this.parcels.delete(p.id); continue; }
      this.parcels.set(p.id, { id: p.id, x: p.x, y: p.y, reward0: p.reward, seenAt: now });
    }
    for (const [id, pb] of this.parcels) {
      if (this.estReward(pb) <= 0) { this.parcels.delete(id); continue; }          // decayed
      if (!sensedIds.has(id)) {
        // no-memory profile forgets immediately; otherwise prune only on evidence
        if (!this.p.memory || manhattan(here, pb) < this.p.obs) this.parcels.delete(id);
      }
    }

    const sensedAgents = this.world.getAgents().filter((a) => typeof a.x === 'number' && typeof a.y === 'number');
    const seenAgents = new Set(sensedAgents.map((a) => a.id));
    for (const a of sensedAgents) {
      const prev = this.agents.get(a.id);
      const dir = prev ? { dx: Math.sign(/** @type {number} */(a.x) - prev.x), dy: Math.sign(/** @type {number} */(a.y) - prev.y) } : { dx: 0, dy: 0 };
      this.agents.set(a.id, { id: a.id, x: /** @type {number} */(a.x), y: /** @type {number} */(a.y), seenAt: now, dir });
    }
    for (const [id, ab] of this.agents) {
      if (!seenAgents.has(id) && now - ab.seenAt > 3000) this.agents.delete(id); // forget stale
    }

    const sensedCrateKeys = new Set(this.world.getCrates().map((c) => `${Math.round(c.x)}_${Math.round(c.y)}`));
    for (const c of this.world.getCrates()) this.crates.set(`${Math.round(c.x)}_${Math.round(c.y)}`, { x: Math.round(c.x), y: Math.round(c.y) });
    for (const key of [...this.crates.keys()]) {
      const [x, y] = key.split('_').map(Number);
      if (!sensedCrateKeys.has(key) && manhattan(here, { x, y }) < this.p.obs) this.crates.delete(key);
    }

    for (const s of this.world.spawnerTiles) {
      if (manhattan(here, s) < this.p.obs) this.spawnerSeen.set(`${s.x}_${s.y}`, now);
    }
  }

  /** Free parcels with an `est` (estimated current reward) field. */
  freeParcels() {
    /** @type {(ParcelBelief & {est:number})[]} */
    const out = [];
    for (const pb of this.parcels.values()) out.push({ ...pb, est: this.estReward(pb) });
    return out;
  }

  agentList() { return [...this.agents.values()]; }

  /** Total estimated reward currently carried (also decaying). */
  carriedValue() {
    let s = 0;
    for (const c of this.carrying.values()) s += this.estReward(c);
    return s;
  }

  /** Believed free parcels located on a given tile (what emitPickup will grab). */
  /** @param {{x:number,y:number}} tile */
  parcelsAt(tile) {
    /** @type {ParcelBelief[]} */
    const out = [];
    for (const pb of this.parcels.values()) if (pb.x === tile.x && pb.y === tile.y) out.push(pb);
    return out;
  }

  /**
   * Register a pickup. `grabbed` are the belief parcels on our tile (source of
   * reward0); `count` is how many the server actually reported (authoritative).
   * @param {ParcelBelief[]} grabbed
   * @param {number} count
   */
  onPickup(grabbed, count) {
    for (const pb of grabbed) {
      this.carrying.set(pb.id, { reward0: pb.reward0, seenAt: pb.seenAt });
      this.parcels.delete(pb.id);
    }
    // If the server picked more than we believed, pad with synthetic entries.
    // Ids start with a LETTER because they end up as PDDL objects in the
    // planning layer, and identifiers starting with '_' can be rejected by
    // PDDL parsers.
    for (let i = grabbed.length; i < count; i++) {
      this.carrying.set(`unk${this._unk++}`, { reward0: 0, seenAt: Date.now() });
    }
  }

  onDeliver() { this.carrying.clear(); }

  /**
   * The least-recently-seen spawner (staleness-based exploration target).
   * Game-first fallback: on maps with NO spawner tiles, roam to a random
   * walkable cell — parcels can still appear (dropped by other agents) and
   * moving sweeps the map with our sensing instead of idling forever.
   */
  exploreTarget() {
    /** @type {{x:number,y:number}|null} */
    let best = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const s of this.world.spawnerTiles) {
      const t = this.spawnerSeen.get(`${s.x}_${s.y}`) ?? 0;
      if (t < oldest) { oldest = t; best = s; }
    }
    if (best) return best;
    const here = this.world.myTile();
    if (this._roam && (this._roam.x !== here.x || this._roam.y !== here.y)) return this._roam;
    const walkable = [...this.world.tileType.entries()].filter(([, t]) => t !== '0');
    if (walkable.length === 0) return null;
    const [key] = walkable[Math.floor(Math.random() * walkable.length)];
    const [x, y] = key.split('_').map(Number);
    /** @type {{x:number,y:number}|null} */
    this._roam = { x, y };
    return this._roam;
  }

  /**
   * Record that an exploration target could not be reached right now.
   *
   * Exploration picks the least-recently-seen spawner, and a spawner is only
   * marked as seen by walking into its sensing radius. A target that is walled
   * off — by crates, by a parked opponent, or simply by a disconnected corner
   * of the map — therefore stays the oldest one forever, gets re-selected on
   * every tick, and the agent stands still precisely when exploring is the
   * only thing worth doing. Counting a failed attempt as a look breaks that
   * loop: the choice rotates to the next candidate, and this tile comes back
   * up on its own once it is the oldest again and possibly reachable.
   *
   * @param {{x:number,y:number}} tile
   */
  noteExploreFailed(tile) {
    const key = `${tile.x}_${tile.y}`;
    if (this.spawnerSeen.has(key)) this.spawnerSeen.set(key, Date.now());
    if (this._roam && this._roam.x === tile.x && this._roam.y === tile.y) this._roam = null;
  }

  /**
   * Cells blocked for pathfinding: remembered crates + agents (and, if enabled,
   * their predicted next cell from the inferred direction).
   * @returns {Set<string>}
   */
  blockedCells() {
    const b = new Set();
    for (const c of this.crates.values()) b.add(`${c.x}_${c.y}`);
    for (const a of this.agents.values()) {
      b.add(`${Math.round(a.x)}_${Math.round(a.y)}`);
      if (this.p.opponentPrediction && (a.dir.dx || a.dir.dy)) {
        b.add(`${Math.round(a.x) + a.dir.dx}_${Math.round(a.y) + a.dir.dy}`);
      }
    }
    return b;
  }
}
