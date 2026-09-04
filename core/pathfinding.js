/**
 * Grid pathfinding, shared by every agent.
 *
 * This module is deliberately decoupled from the game/SDK: the caller passes a
 * `canMove(from, to)` predicate that decides whether a single orthogonal step
 * is legal. Pathfinding therefore knows nothing about tile types, crates,
 * arrows or sockets — all of that lives in the predicate. Working on EDGES (not
 * on node walkability) is what lets us honour directional tiles, whose
 * constraint is on the move, not on the cell. Coordinates are integer tile
 * indices; only orthogonal moves exist in Deliveroo, hence a 4-connected grid.
 *
 * It exposes two interchangeable pathfinders with the SAME signature
 * `(from, targets, canMove) => Cell[] | null`, so a caller can swap the
 * navigation algorithm without touching its control loop:
 *   - `bfsToNearest`   — uninformed, breadth-first. One expansion answers
 *     "is it reachable, and how far?" for MANY targets at once, which is why
 *     it backs the reachability checks and the PDDL subgrid construction;
 *   - `aStarToNearest` — informed, A* with a Manhattan heuristic. Same optimal
 *     path length, far fewer expanded cells, so it backs the movement executor
 *     that runs at clock speed.
 *
 * @typedef {{ x:number, y:number }} Cell
 * @typedef {(from:Cell, to:Cell) => boolean} CanMove
 * @typedef {(from:Cell, targets:Cell[], canMove:CanMove) => Cell[] | null} PathFinder
 */

/** 4-connected neighbourhood (no diagonals: the game only allows orthogonal moves). */
const NEIGHBOURS = [ [1, 0], [-1, 0], [0, 1], [0, -1] ];

/**
 * Move direction to step from one tile to an orthogonally-adjacent one.
 * Server convention: right x+1, left x-1, up y+1, down y-1.
 * @param {Cell} from
 * @param {Cell} to
 * @returns {'up'|'down'|'left'|'right'|null}
 */
export function dirTo(from, to) {
  if (to.x === from.x + 1) return 'right';
  if (to.x === from.x - 1) return 'left';
  if (to.y === from.y + 1) return 'up';
  if (to.y === from.y - 1) return 'down';
  return null;
}

/**
 * Reconstruct a path (including `from` at index 0) from a predecessor map.
 * @param {Map<string,string|null>} prev
 * @param {string} endKey
 * @returns {Cell[]}
 */
function rebuildPath(prev, endKey) {
  /** @type {Cell[]} */
  const path = [];
  /** @type {string|null} */
  let key = endKey;
  while (key) {
    const [x, y] = key.split('_').map(Number);
    path.push({ x, y });
    key = prev.get(key) ?? null;
  }
  return path.reverse();
}

/**
 * Breadth-first search: shortest path (in number of steps) from `from` to the
 * NEAREST reachable tile among `targets`, over the walkable grid.
 *
 * A single BFS expansion from `from` visits every reachable cell once (O(V+E));
 * we then pick the target with the smallest discovered distance and rebuild the
 * path. On an unweighted grid BFS is optimal in step count. It is *uninformed*:
 * it explores in all directions equally (a growing "wavefront").
 *
 * @type {PathFinder}
 */
export function bfsToNearest(from, targets, canMove) {
  if (targets.length === 0) return null;

  /** @type {Map<string, number>} */
  const dist = new Map();
  /** @type {Map<string, string|null>} */
  const prev = new Map();
  const startKey = `${from.x}_${from.y}`;
  dist.set(startKey, 0);
  prev.set(startKey, null);

  /** @type {Cell[]} */
  const queue = [from];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist.get(`${cur.x}_${cur.y}`) ?? 0;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const nKey = `${nx}_${ny}`;
      if (dist.has(nKey) || !canMove(cur, { x: nx, y: ny })) continue;
      dist.set(nKey, d + 1);
      prev.set(nKey, `${cur.x}_${cur.y}`);
      queue.push({ x: nx, y: ny });
    }
  }

  /** @type {string|null} */
  let bestKey = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const t of targets) {
    const key = `${t.x}_${t.y}`;
    const d = dist.get(key);
    if (d !== undefined && d < bestD) { bestD = d; bestKey = key; }
  }
  if (bestKey === null) return null;

  return rebuildPath(prev, bestKey);
}

// ---------------------------------------------------------------------------
// A* — informed search
// ---------------------------------------------------------------------------

/**
 * Tiny binary min-heap ordered by `f`, used as A*'s open set (priority queue).
 * @typedef {{ x:number, y:number, f:number }} HeapNode
 */
class MinHeap {
  constructor() {
    /** @type {HeapNode[]} */
    this.a = [];
  }
  get size() { return this.a.length; }
  /** @param {HeapNode} node */
  push(node) {
    const a = this.a;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  /** @returns {HeapNode | undefined} */
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      while (true) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let s = i;
        if (l < n && a[l].f < a[s].f) s = l;
        if (r < n && a[r].f < a[s].f) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

/**
 * A* search: shortest path from `from` to the NEAREST reachable tile among
 * `targets`, over the walkable grid, guided by a Manhattan heuristic.
 *
 * Heuristic h(cell) = min over targets of Manhattan(cell, target). On a
 * unit-cost 4-connected grid this is **admissible** (never overestimates the
 * true step-distance to the closest target) and **consistent**, so A* returns
 * an optimal path — the same length BFS would find, but typically expanding far
 * fewer cells because the search is *informed* (pulled toward the goal).
 *
 * @type {PathFinder}
 */
export function aStarToNearest(from, targets, canMove) {
  if (targets.length === 0) return null;

  const targetKeys = new Set(targets.map((t) => `${t.x}_${t.y}`));
  /** @param {number} x @param {number} y */
  const h = (x, y) => {
    let best = Number.POSITIVE_INFINITY;
    for (const t of targets) {
      const d = Math.abs(x - t.x) + Math.abs(y - t.y);
      if (d < best) best = d;
    }
    return best;
  };

  const startKey = `${from.x}_${from.y}`;
  /** @type {Map<string, number>} */
  const gScore = new Map([[startKey, 0]]);
  /** @type {Map<string, string|null>} */
  const prev = new Map([[startKey, null]]);
  /** @type {Set<string>} */
  const closed = new Set();

  const open = new MinHeap();
  open.push({ x: from.x, y: from.y, f: h(from.x, from.y) });

  while (open.size > 0) {
    const cur = open.pop();
    if (cur === undefined) break;
    const curKey = `${cur.x}_${cur.y}`;
    if (targetKeys.has(curKey)) return rebuildPath(prev, curKey);
    if (closed.has(curKey)) continue;
    closed.add(curKey);

    const g = gScore.get(curKey) ?? 0;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const nKey = `${nx}_${ny}`;
      if (closed.has(nKey) || !canMove(cur, { x: nx, y: ny })) continue;
      const tentative = g + 1;
      if (tentative < (gScore.get(nKey) ?? Number.POSITIVE_INFINITY)) {
        gScore.set(nKey, tentative);
        prev.set(nKey, curKey);
        open.push({ x: nx, y: ny, f: tentative + h(nx, ny) });
      }
    }
  }
  return null;
}
