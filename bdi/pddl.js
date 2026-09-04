import { onlineSolver } from '@unitn-asa/pddl-client';
import { bfsToNearest } from '../core/pathfinding.js';

/**
 * PDDL layer for Logical_Cassandra.
 *
 * WHERE AND WHEN the planner is invoked — the design question the assignment
 * asks — is answered here: PDDL solves the MULTI-PARCEL
 * "collect-and-deliver" task, exactly where Cassandra's greedy batching is
 * sub-optimal — on a small CONNECTED subgrid. The subgrid is the union of the
 * BFS shortest paths me→each parcel and each parcel→nearest delivery (plus a
 * 1-tile ring to allow reorderings): this guarantees the problem is solvable
 * (a valid route exists inside it) and small. Adjacency respects walls, crates
 * and directional tiles (via world.makeCanMove). The default online planner is
 * satisficing FF: at tile level it favours SHORT plans, so minimizing plan
 * length ≈ minimizing steps ≈ good routing, without needing action costs.
 *
 * Greedy Cassandra remains the fallback when no cluster is worth it or the
 * solver is slow/unavailable, so the agent never breaks.
 *
 * @typedef {import('../core/world.js').World} World
 * @typedef {import('./beliefs.js').BeliefStore} BeliefStore
 * @typedef {import('./strategy.js').Params} Params
 * @typedef {{ kind:'move'|'pickup'|'putdown', dir?:'up'|'down'|'left'|'right' }} Step
 */

const CLUSTER_SPAN = 8;   // consider free parcels within this Manhattan range of me
const MAX_PARCELS = 5;    // cap the goal size (keeps the problem small)
const MAX_TILES = 400;    // cap the subgrid size (keeps the problem tractable)
const SOLVE_TIMEOUT = 4000;

/** Static tile-level Deliveroo domain: move + pickup + putdown. */
const DOMAIN = `(define (domain deliveroo)
  (:requirements :strips)
  (:predicates
    (at ?t) (adjr ?a ?b) (adjl ?a ?b) (adju ?a ?b) (adjd ?a ?b)
    (parcel ?p ?t) (carry ?p) (delivery ?t) (delivered ?p))
  (:action move-right :parameters (?from ?to) :precondition (and (at ?from) (adjr ?from ?to)) :effect (and (at ?to) (not (at ?from))))
  (:action move-left  :parameters (?from ?to) :precondition (and (at ?from) (adjl ?from ?to)) :effect (and (at ?to) (not (at ?from))))
  (:action move-up    :parameters (?from ?to) :precondition (and (at ?from) (adju ?from ?to)) :effect (and (at ?to) (not (at ?from))))
  (:action move-down  :parameters (?from ?to) :precondition (and (at ?from) (adjd ?from ?to)) :effect (and (at ?to) (not (at ?from))))
  (:action pickup  :parameters (?p ?t) :precondition (and (at ?t) (parcel ?p ?t)) :effect (and (carry ?p) (not (parcel ?p ?t))))
  (:action putdown :parameters (?p ?t) :precondition (and (at ?t) (delivery ?t) (carry ?p)) :effect (and (delivered ?p) (not (carry ?p)))))`;

/** @param {Promise<any>} p @param {number} ms */
function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

/** @param {any} s @returns {Step|null} */
function parseStep(s) {
  const a = String(s.action).toUpperCase();
  if (a.startsWith('MOVE-')) return { kind: 'move', dir: /** @type {any} */ (a.slice(5).toLowerCase()) };
  if (a === 'PICKUP') return { kind: 'pickup' };
  if (a === 'PUTDOWN') return { kind: 'putdown' };
  return null;
}

/**
 * Build the PDDL problem over a set of tile keys ("x_y").
 * @param {World} world @param {BeliefStore} beliefs
 * @param {{x:number,y:number,id:string}[]} chosen
 * @param {Set<string>} tileKeys
 * @param {(from:{x:number,y:number}, to:{x:number,y:number}) => boolean} canMove
 * @returns {string|null}
 */
function buildProblem(world, beliefs, chosen, tileKeys, canMove) {
  /** @type {string[]} */ const objects = [];
  /** @type {string[]} */ const init = [];
  for (const key of tileKeys) objects.push('t' + key);

  const dirs = /** @type {[string,number,number][]} */ ([['adjr', 1, 0], ['adjl', -1, 0], ['adju', 0, 1], ['adjd', 0, -1]]);
  for (const key of tileKeys) {
    const [x, y] = key.split('_').map(Number);
    for (const [pred, dx, dy] of dirs) {
      const nkey = `${x + dx}_${y + dy}`;
      if (!tileKeys.has(nkey)) continue;
      if (canMove({ x, y }, { x: x + dx, y: y + dy })) init.push(`(${pred} t${key} t${nkey})`);
    }
  }

  const me = world.myTile();
  init.push(`(at t${me.x}_${me.y})`);

  let hasDeliv = false;
  for (const d of world.deliveryTiles) {
    const k = `${d.x}_${d.y}`;
    if (tileKeys.has(k)) { init.push(`(delivery t${k})`); hasDeliv = true; }
  }
  if (!hasDeliv) return null;

  /** @type {string[]} */ const goals = [];
  for (const p of chosen) {
    const k = `${p.x}_${p.y}`;
    if (!tileKeys.has(k)) continue;
    objects.push(p.id);
    init.push(`(parcel ${p.id} t${k})`);
    goals.push(`(delivered ${p.id})`);
  }
  for (const id of beliefs.carrying.keys()) {
    objects.push(id);
    init.push(`(carry ${id})`);
    goals.push(`(delivered ${id})`);
  }
  if (goals.length === 0) return null;

  return `(define (problem deliveroo) (:domain deliveroo)
  (:objects ${objects.join(' ')})
  (:init ${init.join(' ')})
  (:goal (and ${goals.join(' ')})))`;
}

/**
 * Try to plan a collect-and-deliver route with PDDL.
 *
 * On success the parcel ids the plan was built around are returned with it.
 * A plan is a commitment made under assumptions, and those are the assumptions:
 * the caller needs them to tell, later, whether the plan is still about
 * anything real.
 *
 * @param {World} world @param {BeliefStore} beliefs @param {Params} _params
 * @returns {Promise<{status:'ok',steps:Step[],parcelIds:string[]}|{status:'skip'}|{status:'fail'}>}
 */
export async function planRoute(world, beliefs, _params) {
  const me = world.myTile();
  const free = beliefs.freeParcels().filter((p) => Math.abs(p.x - me.x) + Math.abs(p.y - me.y) <= CLUSTER_SPAN);
  const worthwhile = free.length >= 2 || (beliefs.carryingCount > 0 && free.length >= 1);
  if (!worthwhile || world.deliveryTiles.length === 0) return { status: 'skip' };

  const chosen = free.sort((a, b) => b.est - a.est).slice(0, MAX_PARCELS);
  const canMove = world.makeCanMove(new Set([...beliefs.crates.keys()])); // walls+crates+arrows, not transient agents

  // Subgrid = union of BFS paths me→parcel and parcel→nearest delivery (guarantees connectivity).
  /** @type {Set<string>} */
  const tileKeys = new Set();
  /** @param {{x:number,y:number}[]|null} path */
  const addPath = (path) => { if (path) for (const c of path) tileKeys.add(`${c.x}_${c.y}`); };
  /** @type {{x:number,y:number,id:string}[]} */
  const reachable = [];
  for (const p of chosen) {
    const toP = bfsToNearest(me, [{ x: p.x, y: p.y }], canMove);
    if (!toP) continue; // parcel unreachable → skip it
    addPath(toP);
    addPath(bfsToNearest({ x: p.x, y: p.y }, world.deliveryTiles, canMove));
    reachable.push(p);
  }
  addPath(bfsToNearest(me, world.deliveryTiles, canMove)); // ensure a delivery is connected (for carried)
  if (reachable.length === 0 && beliefs.carryingCount === 0) return { status: 'skip' };
  if (tileKeys.size === 0) return { status: 'skip' };

  // 1-tile ring padding to let the planner find reorderings/shortcuts.
  const padded = new Set(tileKeys);
  for (const key of tileKeys) {
    const [x, y] = key.split('_').map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!world.isWall(x + dx, y + dy)) padded.add(`${x + dx}_${y + dy}`);
    }
  }
  const tiles = padded.size <= MAX_TILES ? padded : tileKeys;
  if (tiles.size > MAX_TILES) return { status: 'skip' };

  const problem = buildProblem(world, beliefs, reachable, tiles, canMove);
  if (!problem) return { status: 'skip' };

  try {
    const plan = await withTimeout(onlineSolver(DOMAIN, problem), SOLVE_TIMEOUT);
    if (!plan || !plan.length) return { status: 'fail' };
    /** @type {Step[]} */
    const steps = [];
    for (const s of plan) { const st = parseStep(s); if (st) steps.push(st); }
    return steps.length ? { status: 'ok', steps, parcelIds: reachable.map((p) => p.id) } : { status: 'fail' };
  } catch {
    return { status: 'fail' };
  }
}
