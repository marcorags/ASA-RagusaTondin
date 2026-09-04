/**
 * Strategy layer: named profiles + orthogonal feature flags + a router that
 * tunes the runtime parameters from the game config.
 *
 * The profiles (ECO / BALANCED / RICH) trade accuracy for cost: each one is a
 * preset of the same four levers (memory, aging, opponent prediction,
 * batching) plus a reconsideration margin. Every lever is also settable on its
 * own from the environment, which is what makes controlled ablations possible:
 * run the same agent twice with one lever flipped and the difference is
 * attributable. The router then adjusts for what the map actually looks like.
 *
 * @typedef {{
 *   profile: string,
 *   memory: boolean, aging: boolean, opponentPrediction: boolean, batching: boolean,
 *   debug: boolean,
 *   tick: number, reconsiderMargin: number, distTiebreak: number,
 *   decayMs: number, obs: number, moveMs: number,
 * }} Params
 */

/** @type {Record<string, number>} */
const EVENT_MS = {
  frame: 50, '1s': 1000, '2s': 2000, '5s': 5000, '10s': 10000,
  '1m': 60000, '1h': 3600000, infinite: Number.POSITIVE_INFINITY,
};

/** @type {Record<string, {memory:boolean,aging:boolean,opponentPrediction:boolean,batching:boolean,reconsiderMargin:number}>} */
const PROFILES = {
  ECO:      { memory: false, aging: false, opponentPrediction: false, batching: true, reconsiderMargin: 0.35 },
  BALANCED: { memory: true,  aging: true,  opponentPrediction: true,  batching: true, reconsiderMargin: 0.20 },
  RICH:     { memory: true,  aging: true,  opponentPrediction: true,  batching: true, reconsiderMargin: 0.15 },
};

/**
 * Build the runtime parameters from the game config + env flags + router.
 * @param {any} config
 * @returns {Params}
 */
export function resolveStrategy(config) {
  const name = (process.env.PROFILE || 'BALANCED').toUpperCase();
  const base = PROFILES[name] || PROFILES.BALANCED;
  const clock = config?.CLOCK ?? 50;
  const game = config?.GAME ?? {};
  const decayMs = EVENT_MS[game?.parcels?.decaying_event ?? '1s'] ?? 1000;
  // observation_distance === -1 means UNLIMITED sensing on the server side.
  // Normalize it to ∞, or every "is it within view?" test would be false and
  // the evidence-based pruning would never fire (ghost beliefs forever).
  const obsRaw = game?.player?.observation_distance ?? 5;
  const obs = obsRaw === -1 ? Number.POSITIVE_INFINITY : obsRaw;
  const moveMs = game?.player?.movement_duration ?? clock;

  /** @param {string} n @param {boolean} cur */
  const flag = (n, cur) => (process.env[n] === undefined ? cur : process.env[n] === '1');

  /** @type {Params} */
  const p = {
    profile: name in PROFILES ? name : 'BALANCED',
    memory: flag('MEMORY', base.memory),
    aging: flag('AGING', base.aging),
    opponentPrediction: flag('OPPONENT_PREDICTION', base.opponentPrediction),
    batching: flag('BATCHING', base.batching),
    debug: process.env.DEBUG_LOG === '1',
    tick: clock,
    reconsiderMargin: base.reconsiderMargin,
    distTiebreak: 0.1,
    decayMs, obs, moveMs,
  };

  // Router: tune from the map/config.
  const w = game?.map?.width ?? 20;
  const h = game?.map?.height ?? 20;
  if (Math.max(w, h) >= 35 && obs <= 5) p.reconsiderMargin += 0.05; // big map + short sight → steadier commitment

  return p;
}
