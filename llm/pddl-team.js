import { onlineSolver } from '@unitn-asa/pddl-client';
import { bfsToNearest } from '../core/pathfinding.js';

/**
 * PDDL in Agent B: JOINT team planning for the rendezvous missions. This is
 * a genuinely TWO-AGENT planning problem, not a path query with an extra
 * parameter — both agents must end on DISTINCT tiles inside the rendezvous
 * zone, and the planner is what decides who takes which one so that the total
 * travel is minimized.
 *
 * Division of labour, the same one the single-agent planner uses:
 *  - the LLM compiles NL → a structured goal (point + radius in MissionSpec);
 *    it never writes raw PDDL (unvalidatable, an injection surface — CaMeL);
 *  - this builder compiles the goal → a validated STRIPS problem;
 *  - the solver's value is the ASSIGNMENT (who stands where): we extract the
 *    two `arrive` actions and DISCARD the move steps — each agent walks its
 *    own leg with A*, which copes with live obstacles far better than a
 *    frozen step sequence computed seconds earlier;
 *  - no plan, solver down, or no teammate ⇒ the caller falls back to
 *    independent navigation: the team degrades, it never breaks.
 *
 * Distinct-tiles guarantee in pure STRIPS: `zonefree` tokens (the sokoban
 * `free` trick) — arrive1 consumes the token of its tile, so arrive2 cannot
 * pick the same one. No negative preconditions needed.
 */

const MAX_TILES = 300;
// 15s: measured — the 2-agent joint problem times out at 5s (dual-bfws).
// Affordable HERE because the head is asynchronous: the body keeps farming
// while the solver thinks (the two-speed principle paying off again), and
// the mission's own budget (walk + 60s hold) dwarfs it.
const SOLVE_TIMEOUT = 15000;

export const MEET_DOMAIN = `(define (domain team-meet)
  (:requirements :strips)
  (:predicates
    (at1 ?t) (at2 ?t) (adjr ?a ?b) (adjl ?a ?b) (adju ?a ?b) (adjd ?a ?b)
    (zone ?t) (zonefree ?t) (met1) (met2))
  (:action m1r :parameters (?f ?t) :precondition (and (at1 ?f) (adjr ?f ?t)) :effect (and (at1 ?t) (not (at1 ?f))))
  (:action m1l :parameters (?f ?t) :precondition (and (at1 ?f) (adjl ?f ?t)) :effect (and (at1 ?t) (not (at1 ?f))))
  (:action m1u :parameters (?f ?t) :precondition (and (at1 ?f) (adju ?f ?t)) :effect (and (at1 ?t) (not (at1 ?f))))
  (:action m1d :parameters (?f ?t) :precondition (and (at1 ?f) (adjd ?f ?t)) :effect (and (at1 ?t) (not (at1 ?f))))
  (:action m2r :parameters (?f ?t) :precondition (and (at2 ?f) (adjr ?f ?t)) :effect (and (at2 ?t) (not (at2 ?f))))
  (:action m2l :parameters (?f ?t) :precondition (and (at2 ?f) (adjl ?f ?t)) :effect (and (at2 ?t) (not (at2 ?f))))
  (:action m2u :parameters (?f ?t) :precondition (and (at2 ?f) (adju ?f ?t)) :effect (and (at2 ?t) (not (at2 ?f))))
  (:action m2d :parameters (?f ?t) :precondition (and (at2 ?f) (adjd ?f ?t)) :effect (and (at2 ?t) (not (at2 ?f))))
  (:action arrive1 :parameters (?t) :precondition (and (at1 ?t) (zone ?t) (zonefree ?t)) :effect (and (met1) (not (zonefree ?t))))
  (:action arrive2 :parameters (?t) :precondition (and (at2 ?t) (zone ?t) (zonefree ?t)) :effect (and (met2) (not (zonefree ?t)))))`;

/**
 * Build the joint-meet problem over a tile-key set ("x_y").
 * Exported for deterministic testing (no network needed).
 * @param {Set<string>} tileKeys
 * @param {(from:{x:number,y:number}, to:{x:number,y:number}) => boolean} canMove
 * @param {{x:number,y:number}} pos1 - Loqua
 * @param {{x:number,y:number}} pos2 - teammate
 * @param {{x:number,y:number}[]} zoneTiles
 * @returns {string}
 */
export function buildMeetProblem(tileKeys, canMove, pos1, pos2, zoneTiles) {
  /** @type {string[]} */ const init = [];
  const dirs = /** @type {[string,number,number][]} */ ([['adjr', 1, 0], ['adjl', -1, 0], ['adju', 0, 1], ['adjd', 0, -1]]);
  for (const key of tileKeys) {
    const [x, y] = key.split('_').map(Number);
    for (const [pred, dx, dy] of dirs) {
      const nkey = `${x + dx}_${y + dy}`;
      if (tileKeys.has(nkey) && canMove({ x, y }, { x: x + dx, y: y + dy })) init.push(`(${pred} t${key} t${nkey})`);
    }
  }
  init.push(`(at1 t${pos1.x}_${pos1.y})`, `(at2 t${pos2.x}_${pos2.y})`);
  for (const z of zoneTiles) {
    const k = `${z.x}_${z.y}`;
    if (tileKeys.has(k)) init.push(`(zone t${k})`, `(zonefree t${k})`);
  }
  return `(define (problem team-meet) (:domain team-meet)
  (:objects ${[...tileKeys].map((k) => 't' + k).join(' ')})
  (:init ${init.join(' ')})
  (:goal (and (met1) (met2))))`;
}

/** @param {Promise<any>} p @param {number} ms */
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/**
 * Solve the joint rendezvous. Returns the two ASSIGNED zone tiles (distinct
 * by construction) or null (caller falls back to independent navigation).
 * @param {import('../core/world.js').World} world
 * @param {import('../bdi/beliefs.js').BeliefStore} beliefs
 * @param {{x:number,y:number}} teammatePos
 * @param {{x:number,y:number}} point
 * @param {number} radius
 * @returns {Promise<{mine:{x:number,y:number}, mate:{x:number,y:number}, planSteps:number}|null>}
 */
export async function planMeet(world, beliefs, teammatePos, point, radius) {
  const me = world.myTile();
  const canMove = world.makeCanMove(new Set([...beliefs.crates.keys()])); // static picture (walls+crates+arrows)
  /** @type {{x:number,y:number}[]} */
  const zone = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius + Math.abs(dx); dy <= radius - Math.abs(dx); dy++) {
      const c = { x: point.x + dx, y: point.y + dy };
      if (c.x >= 0 && c.y >= 0 && c.x < world.worldMap.width && c.y < world.worldMap.height && !world.isWall(c.x, c.y)) zone.push(c);
    }
  }
  if (zone.length < 2) return null; // two agents need two distinct tiles

  const p1 = bfsToNearest(me, zone, canMove);
  const p2 = bfsToNearest(teammatePos, zone, canMove);
  if (!p1 || !p2) return null;

  // SCOPE THE PLAN TO WHERE THE DECISION LIVES (measured escalation: full
  // paths+ring → timeout at 5s; lean paths → timeout at 15s — the 2-agent
  // state space grows with |tiles|²). The joint interaction only matters in
  // the terminal region: plan over the ZONE plus a short entry STUB of each
  // path; the long legs are A*'s job anyway (the move steps are discarded).
  const nearLimit = radius + 3;
  /** @param {{x:number,y:number}[]} path */
  const stub = (path) => path.filter((c) => Math.abs(c.x - point.x) + Math.abs(c.y - point.y) <= nearLimit);
  const s1 = stub(p1);
  const s2 = stub(p2);
  if (s1.length === 0 || s2.length === 0) return null;

  /** @type {Set<string>} */
  const tileKeys = new Set();
  for (const path of [s1, s2]) for (const c of path) tileKeys.add(`${c.x}_${c.y}`);
  for (const z of zone) tileKeys.add(`${z.x}_${z.y}`);
  if (tileKeys.size > MAX_TILES) { console.log(`[pddl] joint meet skipped: subgrid ${tileKeys.size} > ${MAX_TILES} tiles`); return null; }

  // Initial positions = each agent's ENTRY POINT into the near-zone region.
  const problem = buildMeetProblem(tileKeys, canMove, s1[0], s2[0], zone);
  try {
    const plan = await withTimeout(onlineSolver(MEET_DOMAIN, problem), SOLVE_TIMEOUT);
    if (!plan || !plan.length) { console.log('[pddl] joint meet: solver returned no plan'); return null; }
    /** @param {string} name */
    const arriveTile = (name) => {
      const step = plan.find((/** @type {any} */ s) => String(s.action).toUpperCase() === name);
      const m = step ? /^t(\d+)_(\d+)$/i.exec(String(step.args?.[0] ?? '')) : null;
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    };
    const mine = arriveTile('ARRIVE1');
    const mate = arriveTile('ARRIVE2');
    if (!mine || !mate) { console.log('[pddl] joint meet: arrive actions missing from plan'); return null; }
    return { mine, mate, planSteps: plan.length };
  } catch (err) {
    // Never silent: a swallowed failure reason costs an entire diagnosis round.
    console.log(`[pddl] joint meet failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
