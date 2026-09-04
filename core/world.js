import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

/**
 * Shared world model / bootstrap for every agent.
 *
 * It encapsulates the tricky bits once, so nobody has to re-discover them:
 *   - the SDK bootstrap gotcha: with DjsConnect() the client.config/map/me
 *     promises are undefined (enhance() copies only prototype methods), so we
 *     bootstrap via events registered up-front;
 *   - the static map (tile types, delivery/spawner lists, wall test);
 *   - the EDGE-feasibility predicate `canMove(from,to)` honouring walls, crates,
 *     other agents (dynamic obstacles) and directional tiles.
 *
 * Beliefs are the current percept only (no memory): parcels/crates/agents are
 * replaced wholesale at every sensing; `me` is mutated in place.
 *
 * @typedef {{ id:string, name:string, x:number, y:number, score:number }} Me
 * @typedef {{ id:string, x:number, y:number, carriedBy?:string, reward:number }} Parcel
 * @typedef {{ id:string, x:number, y:number }} CrateView
 * @typedef {{ id:string, x?:number, y?:number }} AgentView
 */

/** Directional tiles: cannot ENTER moving against the arrow (exit unrestricted). */
const ARROWS = /** @type {Record<string, {dx:number, dy:number}>} */ ({
  '←': { dx: -1, dy: 0 }, '↑': { dx: 0, dy: 1 }, '→': { dx: 1, dy: 0 }, '↓': { dx: 0, dy: -1 },
});

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The shared world model returned by connectWorld().
 * @typedef {{
 *   client: any,
 *   config: any,
 *   worldMap: { width:number, height:number, tiles:any[] },
 *   CLOCK: number,
 *   capacity: number,
 *   tileType: Map<string,string>,
 *   deliveryTiles: {x:number,y:number}[],
 *   spawnerTiles: {x:number,y:number}[],
 *   me: Me,
 *   myTile: () => {x:number,y:number},
 *   getParcels: () => Parcel[],
 *   getCrates: () => CrateView[],
 *   getAgents: () => AgentView[],
 *   isWall: (x:number,y:number) => boolean,
 *   blockedCells: () => Set<string>,
 *   makeCanMove: (blocked:Set<string>) => import('./pathfinding.js').CanMove,
 * }} World
 */

/**
 * Connect to the game and build the shared world model.
 * @param {string} name - in-game player name (lets several agents run at once)
 * @returns {Promise<World>}
 */
export async function connectWorld(name) {
  const client = DjsConnect(process.env.HOST, process.env.TOKEN, name);

  // --- Beliefs: current percept only ---
  /** @type {Me} */
  const me = { id: '', name: '', x: 0, y: 0, score: 0 };
  /** @type {() => void} */
  let markMeReady = () => {};
  /** @type {Promise<void>} */
  const meReady = new Promise((res) => { markMeReady = () => res(); });
  client.onYou((a) => {
    me.id = a.id;
    me.name = a.name;
    if (typeof a.x === 'number') me.x = a.x;
    if (typeof a.y === 'number') me.y = a.y;
    me.score = a.score;
    markMeReady();
  });

  /** @type {Parcel[]} */
  let parcels = [];
  /** @type {CrateView[]} */
  let crates = [];
  /** @type {AgentView[]} */
  let agents = [];
  client.onSensing((s) => {
    parcels = s.parcels;
    crates = s.crates;
    agents = s.agents;
  });

  // --- Static map: bootstrap via events registered up-front ---
  const configReady = new Promise((res) => client.onConfig((c) => res(c)));
  const mapReady = new Promise((res) => client.onMap((width, height, tiles) => res({ width, height, tiles })));
  const config = await configReady;
  const worldMap = await mapReady;
  await meReady;

  /** Tile type by "x_y" key, normalized to string. */
  const tileType = new Map();
  /** @type {{x:number,y:number}[]} */
  const deliveryTiles = [];
  /** @type {{x:number,y:number}[]} */
  const spawnerTiles = [];
  for (const t of worldMap.tiles) {
    const type = String(t.type);
    tileType.set(`${t.x}_${t.y}`, type);
    if (type === '2') deliveryTiles.push({ x: t.x, y: t.y });
    if (type === '1') spawnerTiles.push({ x: t.x, y: t.y });
  }

  /** @param {number} x @param {number} y */
  const isWall = (x, y) => {
    const type = tileType.get(`${x}_${y}`);
    return type === undefined || type === '0';
  };

  /**
   * Set of cells currently blocked by dynamic obstacles (crates + other agents),
   * from the latest sensing. Rebuild once per tick before pathfinding.
   * @returns {Set<string>}
   */
  const blockedCells = () => {
    const b = new Set();
    for (const c of crates) b.add(`${Math.round(c.x)}_${Math.round(c.y)}`);
    for (const a of agents) {
      if (typeof a.x === 'number' && typeof a.y === 'number') b.add(`${Math.round(a.x)}_${Math.round(a.y)}`);
    }
    return b;
  };

  /**
   * Build an EDGE feasibility predicate for pathfinding given a set of blocked cells.
   * @param {Set<string>} blocked
   * @returns {import('./pathfinding.js').CanMove}
   */
  const makeCanMove = (blocked) => (from, to) => {
    const key = `${to.x}_${to.y}`;
    if (isWall(to.x, to.y)) return false;
    if (blocked.has(key)) return false;
    const arrow = ARROWS[/** @type {string} */ (tileType.get(key))];
    if (arrow && to.x - from.x === -arrow.dx && to.y - from.y === -arrow.dy) return false;
    return true;
  };

  const myTile = () => ({ x: Math.round(me.x), y: Math.round(me.y) });

  return {
    client,
    config,
    worldMap,
    CLOCK: config?.CLOCK ?? 50,
    capacity: config?.GAME?.player?.capacity ?? Number.POSITIVE_INFINITY,
    tileType,
    deliveryTiles,
    spawnerTiles,
    me,
    myTile,
    getParcels: () => parcels,
    getCrates: () => crates,
    getAgents: () => agents,
    isWall,
    blockedCells,
    makeCanMove,
  };
}
