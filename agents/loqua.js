import { connectWorld, sleep } from '../core/world.js';
import { bfsToNearest } from '../core/pathfinding.js';
import { resolveStrategy } from '../bdi/strategy.js';
import { generateOptions, reviseIntention } from '../bdi/deliberation.js';
import { stepToward } from '../bdi/plans.js';
import { LlmClient } from '../llm/llm-client.js';
import { createTools } from '../llm/tools.js';
import { ReactInterpreter, parseJsonAnswer } from '../llm/interpreter.js';
import { missionSystem, normalizeMissionKind, PROMPT_VERSION } from '../llm/prompts.js';
import { MissionInbox } from '../llm/inbox.js';
import { ConveniencePolicy } from '../llm/policy.js';
import { Directives, DirectiveAwareBeliefs, applyDirectives } from '../bdi/directives.js';
import { TeamProtocol } from '../core/team-protocol.js';
import { planMeet } from '../llm/pddl-team.js';

const world = await connectWorld('Loqua');
const params = resolveStrategy(world.config);
const directives = new Directives();
const beliefs = new DirectiveAwareBeliefs(world, params, directives);
const policy = new ConveniencePolicy(params);
const VERBOSE = process.env.DEBUG_LLM === '1';

const tools = createTools({
  getState: () => JSON.stringify({
    me: world.myTile(),
    score: world.me.score,
    carrying: beliefs.carryingCount,
    map: { width: world.worldMap.width, height: world.worldMap.height },
    visibleParcels: beliefs.freeParcels().slice(0, 10).map((p) => ({ x: p.x, y: p.y, reward: p.est })),
    deliveryTiles: world.deliveryTiles.slice(0, 10),
    activeDirectives: directives.describe(),
  }),
});
const llm = new LlmClient();
const interpreter = new ReactInterpreter(llm, tools, {
  systemPrompt: missionSystem(tools.catalog),
  verbose: VERBOSE,
});

/** @param {any} raw */
function validateSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = normalizeMissionKind(raw.kind);
  /** @param {any} c */
  const inMap = (c) => Number.isInteger(c?.x) && Number.isInteger(c?.y)
    && c.x >= 0 && c.y >= 0 && c.x < world.worldMap.width && c.y < world.worldMap.height;
  const options = Array.isArray(raw.params?.options) ? raw.params.options.filter(inMap).map((/** @type {any} */ c) => ({ x: c.x, y: c.y })) : [];
  const tiles = Array.isArray(raw.params?.tiles) ? raw.params.tiles.filter(inMap).map((/** @type {any} */ c) => ({ x: c.x, y: c.y })) : [];
  const rewardHint = typeof raw.rewardHint === 'number' ? raw.rewardHint : null;
  const answer = typeof raw.answer === 'string' && raw.answer.trim() !== '' ? raw.answer.trim() : null;
  const count = Number.isInteger(raw.params?.count) && raw.params.count >= 1 ? raw.params.count : null;
  const threshold = Number.isInteger(raw.params?.threshold) && raw.params.threshold >= 0 ? raw.params.threshold : null;
  const point = inMap(raw.params) ? { x: raw.params.x, y: raw.params.y } : null;
  const maxDistance = Number.isInteger(raw.params?.maxDistance) && raw.params.maxDistance >= 0 ? raw.params.maxDistance : 3;
  return { kind, options, tiles, rewardHint, answer, count, threshold, point, maxDistance, reason: String(raw.reason ?? '') };
}

/** @type {{kind:'goto'|'drop_at', target:{x:number,y:number}, senderId:string, deadline:number, gain:number, settleUntil?:number, holdMs?:number, holdUntil?:number}[]} */
const missionGoals = [];

/** Apply provisional avoidance before asynchronous LLM interpretation. @param {string} text */
function hazardReflex(text) {
  if (!/\b(do not|don'?t|never|avoid)\b/i.test(text)) return;
  const coords = [...text.matchAll(/\((\d+)\s*,\s*(\d+)\)/g)]
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
    .filter((c) => c.x < world.worldMap.width && c.y < world.worldMap.height);
  if (coords.length === 0) return;
  directives.addForbidden(coords);
  protocol.sendDirective({ forbidden: coords }); // protect the teammate at reflex speed too
  console.log(`[reflex] provisional avoidance: ${coords.length} tile(s) forbidden in ~0ms (LLM interpretation will confirm)`);
}

async function handleMission(/** @type {string} */ text, /** @type {string} */ senderId, /** @type {string} */ senderName) {
  console.log(`[mission] from ${senderName}(${senderId}): ${text.slice(0, 120)}`);
  hazardReflex(text);
  const t0 = Date.now();
  const result = await interpreter.run(`Message received:\n<<<${text}>>>`);
  const spec = validateSpec(parseJsonAnswer(result.answer));
  console.log(`[mission] interpreted in ${Date.now() - t0}ms, ${result.iterations} turn(s) → ${JSON.stringify(spec)}`);
  if (!spec) { console.log('[mission] uninterpretable → ignored (agent keeps playing)'); return; }

  // Recover a kind from unambiguous parameters or handoff text.
  if (spec.kind === 'other') {
    if (spec.point) spec.kind = 'meet_at';
    else if (spec.count) spec.kind = 'deliver_exactly';
    else if (spec.threshold !== null) spec.kind = 'deliver_value_max';
    else if (/pick/i.test(text) && /deliver/i.test(text) && /\b(another|other|different)\s+agent/i.test(text)) spec.kind = 'handoff';
    if (spec.kind !== 'other') console.log(`[mission] kind rescued: other → ${spec.kind} (redundant evidence: parameter/text shape)`);
  }

  // Reply when a valid answer is present despite an unknown kind.
  if (spec.answer && (spec.kind === 'answer' || spec.kind === 'other')) {
    const res = await world.client.emitSay(senderId, spec.answer);
    console.log(`[mission] answered "${spec.answer}" → ${res}`);
    if (spec.kind === 'answer') return;
  }

  // Negative goto/drop_at missions identify penalty tiles.
  const penaltyTiles = spec.kind === 'avoid' ? spec.tiles
    : (spec.kind === 'goto' || spec.kind === 'drop_at') && spec.rewardHint !== null && spec.rewardHint < 0 ? spec.options
    : null;
  if (penaltyTiles) {
    if (penaltyTiles.length === 0) { console.log('[mission] avoidance with no valid tiles → ignored'); return; }
    directives.addForbidden(penaltyTiles);
    protocol.sendDirective({ forbidden: penaltyTiles });
    console.log(`[policy] avoidance directive: ${penaltyTiles.length} tile(s) forbidden (penalty ${spec.rewardHint ?? '?'}) — A* now routes around them (forwarded to teammate)`);
    return;
  }

  if (spec.kind === 'deliver_exactly' && spec.count) {
    if (spec.rewardHint !== null && spec.rewardHint < 0) { console.log('[policy] negative persistent rule → ignored'); return; }
    directives.batchSize = Math.min(spec.count, world.capacity);
    if (directives.batchSize !== spec.count) console.log(`[policy] batch ${spec.count} exceeds capacity ${world.capacity} → capped`);
    protocol.sendDirective({ batchSize: directives.batchSize });
    console.log(`[policy] directive: deliver EXACTLY ${directives.batchSize} parcels at a time (persistent, forwarded) | active: ${directives.describe()}`);
    return;
  }
  if (spec.kind === 'deliver_value_max' && spec.threshold !== null) {
    if (spec.rewardHint !== null && spec.rewardHint < 0) { console.log('[policy] negative persistent rule → ignored'); return; }
    directives.deliverValueMax = spec.threshold;
    protocol.sendDirective({ deliverValueMax: spec.threshold });
    console.log(`[policy] directive: deliveries capped at total reward ≤ ${spec.threshold} (persistent, forwarded; decay-parking enabled) | active: ${directives.describe()}`);
    return;
  }

  if (spec.kind === 'stop_go') {
    directives.stopGoArmed = true;
    protocol.sendDirective({ stopGoArmed: true });
    console.log(`[policy] stop-go armed (persistent, forwarded) — movement now gated by RED/GREEN messages | active: ${directives.describe()}`);
    return;
  }
  if (spec.kind === 'meet_at' && spec.point) {
    const from = world.myTile();
    const canMove = world.makeCanMove(beliefs.blockedCells());
    /** @type {{x:number,y:number}[]} */
    const candidates = [];
    for (let dx = -spec.maxDistance; dx <= spec.maxDistance; dx++) {
      for (let dy = -spec.maxDistance + Math.abs(dx); dy <= spec.maxDistance - Math.abs(dx); dy++) {
        const c = { x: spec.point.x + dx, y: spec.point.y + dy };
        if (c.x >= 0 && c.y >= 0 && c.x < world.worldMap.width && c.y < world.worldMap.height && !world.isWall(c.x, c.y)) candidates.push(c);
      }
    }
    const path = candidates.length ? bfsToNearest(from, candidates, canMove) : null;
    if (!path) { console.log('[mission] meet_at: no reachable tile within radius → ignored'); return; }
    const holdMs = 60000;
    const seconds = ((path.length - 1) * params.moveMs) / 1000 + holdMs / 1000;
    const cost = policy.earningRate() * seconds;
    if ((spec.rewardHint ?? 0) <= cost * 1.2) {
      console.log(`[policy] meet_at ignored: gain ${spec.rewardHint ?? 0} ≤ cost ~${Math.round(cost)} pts (${Math.round(seconds)}s incl. wait)`);
      return;
    }
    // Joint PDDL planning assigns distinct meeting tiles.
    let target = path[path.length - 1];
    /** @type {{x:number,y:number}|null} */
    let mateAssigned = null;
    if (teammatePos) {
      const jp = await planMeet(world, beliefs, teammatePos, spec.point, spec.maxDistance);
      if (jp) {
        target = jp.mine;
        mateAssigned = jp.mate;
        console.log(`[pddl] joint meet plan (${jp.planSteps} steps): me → (${jp.mine.x},${jp.mine.y}), teammate → (${jp.mate.x},${jp.mate.y})`);
      } else {
        console.log('[pddl] joint plan unavailable → independent navigation fallback');
      }
    }
    missionGoals.push({ kind: 'goto', target, senderId, deadline: Date.now() + Math.max(90000, (path.length - 1) * params.moveMs * 5), gain: spec.rewardHint ?? 0, holdMs });
    missionGoals.sort((a, b) => b.gain - a.gain);
    protocol.sendTask({ kind: 'meet_at', x: spec.point.x, y: spec.point.y, maxDistance: spec.maxDistance, holdMs, ...(mateAssigned ? { assigned: mateAssigned } : {}) });
    console.log(`[policy] meet_at adopted: me → (${target.x},${target.y}), teammate tasked${mateAssigned ? ' (PDDL-assigned)' : ''}; both hold ${holdMs / 1000}s`);
    return;
  }
  if (spec.kind === 'handoff') {
    // The teammate drops beside delivery; Loqua picks up and delivers.
    const from = world.myTile();
    /** @param {{x:number,y:number}} d */
    const dist = (d) => Math.abs(d.x - from.x) + Math.abs(d.y - from.y);
    const nearestDeliv = world.deliveryTiles.length ? world.deliveryTiles.reduce((a, b) => (dist(a) <= dist(b) ? a : b)) : null;
    if (!nearestDeliv) { console.log('[mission] handoff: no delivery tiles → ignored'); return; }
    const isDeliv = (/** @type {number} */ x, /** @type {number} */ y) => world.deliveryTiles.some((d) => d.x === x && d.y === y);
    const dropZone = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => ({ x: nearestDeliv.x + dx, y: nearestDeliv.y + dy }))
      .find((c) => c.x >= 0 && c.y >= 0 && c.x < world.worldMap.width && c.y < world.worldMap.height
        && !world.isWall(c.x, c.y) && !isDeliv(c.x, c.y) && !directives.forbiddenTiles.has(`${c.x}_${c.y}`));
    if (!dropZone) { console.log('[mission] handoff: no valid drop zone → ignored'); return; }
    handoffZone = dropZone;
    protocol.sendTask({ kind: 'handoff-picker', dropZone });
    console.log(`[policy] handoff adopted: teammate = picker → drop zone (${dropZone.x},${dropZone.y}); Loqua = deliverer (zone pickups repriced +bonus)`);
    return;
  }

  if ((spec.kind === 'goto' || spec.kind === 'drop_at') && spec.options.length > 0) {
    // Decline unreachable targets to avoid stalling the agent.
    const from = world.myTile();
    const canMove = world.makeCanMove(beliefs.blockedCells());
    const path = bfsToNearest(from, spec.options, canMove);
    if (!path) {
      console.log(`[mission] no reachable target among ${JSON.stringify(spec.options)} → ignored`);
      return;
    }
    const v = policy.evaluate(spec.rewardHint, path.length - 1);
    if (!v.adopt) {
      console.log(`[policy] ignored: gain ${v.gain} ≤ opportunity cost ~${v.cost} pts (${v.seconds}s at ${v.rate} pts/s of standard play)`);
      return;
    }
    const target = path[path.length - 1];
    const deadline = Date.now() + Math.max(30000, (path.length - 1) * params.moveMs * 5);
    missionGoals.push({ kind: spec.kind, target, senderId, deadline, gain: v.gain });
    missionGoals.sort((a, b) => b.gain - a.gain);
    console.log(`[policy] adopted ${spec.kind} → (${target.x},${target.y}): gain ${v.gain} > cost ~${v.cost} pts (path ${path.length - 1} steps, deadline +${Math.round((deadline - Date.now()) / 1000)}s)`);
    return;
  }

  console.log(`[mission] kind=${spec.kind} → ignored (${spec.reason})`);
}

/** Teammate position from the belief exchange (needed for joint planning). @type {{x:number,y:number}|null} */
let teammatePos = null;

const protocol = new TeamProtocol(world.client, {
  name: 'Loqua',
  onBelief: (/** @type {any} */ payload) => {
    if (Number.isInteger(payload?.pos?.x) && Number.isInteger(payload?.pos?.y)) teammatePos = { x: payload.pos.x, y: payload.pos.y };
    if (!Array.isArray(payload?.parcels)) return;
    for (const p of payload.parcels) {
      if (typeof p?.id !== 'string' || !Number.isInteger(p.x) || !Number.isInteger(p.y)) continue;
      if (!beliefs.parcels.has(p.id)) beliefs.parcels.set(p.id, { id: p.id, x: p.x, y: p.y, reward0: Number(p.reward) || 0, seenAt: Date.now() });
    }
  },
});
protocol.attach(world.me.id);
setInterval(() => {
  const parcels = beliefs.freeParcels().slice(0, 8).map((p) => ({ id: p.id, x: p.x, y: p.y, reward: p.est }));
  protocol.sendBelief({ parcels, pos: world.myTile() }); // pos always: joint planning needs it
}, 5000);

/** Parcels denied by a claim, avoided for a cooldown. @type {Map<string, number>} */
const denied = new Map();
const notDenied = (/** @type {import('../bdi/deliberation.js').Option} */ o) =>
  o.type !== 'go_pick_up' || !o.id || (denied.get(o.id) ?? 0) < Date.now();

/** @type {{x:number,y:number}|null} */
let handoffZone = null;
const HANDOFF_BOOST = 50;
/** @param {import('../bdi/deliberation.js').Option[]} options */
function repriceHandoff(options) {
  const zone = handoffZone;
  if (!zone) return options;
  return options
    .map((o) => o.type === 'go_pick_up' && o.target.x === zone.x && o.target.y === zone.y ? { ...o, u: o.u + HANDOFF_BOOST } : o)
    .sort((a, b) => b.u - a.u);
}

/** State changes bypass LLM interpretation and deduplication to gate movement immediately. @param {string} text */
function stopGoReflex(text) {
  const t = text.trim();
  if (!directives.stopGoArmed && /red\s*light/i.test(t) && /green\s*light/i.test(t) && /\b(stop|wait|penalt)/i.test(t)) {
    directives.stopGoArmed = true;
    protocol.sendDirective({ stopGoArmed: true });
    console.log('[reflex] stop-go ARMED (announce pattern) — movement now gated by RED/GREEN');
  }
  if (!directives.stopGoArmed) return;
  if (/^\W*red\s*light/i.test(t)) {
    if (!directives.halt) { directives.halt = true; protocol.sendDirective({ halt: true }); console.log('[reflex] RED LIGHT → halted (forwarded)'); }
    return;
  }
  if (/^\W*green\s*light/i.test(t)) {
    if (directives.halt) { directives.halt = false; protocol.sendDirective({ halt: false }); console.log('[reflex] GREEN LIGHT → resumed (forwarded)'); }
  }
}

const inbox = new MissionInbox(world, { onMission: handleMission, onRaw: stopGoReflex, debug: VERBOSE });
inbox.attach();

/** @param {{kind:'goto'|'drop_at', target:{x:number,y:number}, senderId:string, deadline:number, gain:number, settleUntil?:number, holdMs?:number, holdUntil?:number}} goal @returns {Promise<boolean>} */
async function stepMission(goal) {
  if (Date.now() > goal.deadline) {
    console.log(`[mission] ${goal.kind} → (${goal.target.x},${goal.target.y}) abandoned (deadline expired) — resuming standard play`);
    missionGoals.shift();
    return false;
  }
  const from = world.myTile();
  const atTarget = from.x === goal.target.x && from.y === goal.target.y;

  if (goal.kind === 'goto') {
    if (atTarget) {
      if (goal.holdMs) {
        if (!goal.holdUntil) { goal.holdUntil = Date.now() + goal.holdMs; console.log(`[mission] holding at (${from.x},${from.y}) for ${goal.holdMs / 1000}s`); }
        if (Date.now() < goal.holdUntil) return false;
      }
      console.log(`[mission] goto (${goal.target.x},${goal.target.y}) completed`);
      missionGoals.shift();
      return true; // reaching the tile IS the completion (rewards are observed server-side)
    }
    return stepToward(world, beliefs, { key: 'mission:goto', type: 'explore', target: goal.target, u: 1 });
  }

  if (beliefs.carryingCount === 0) {
    const parcels = beliefs.freeParcels();
    if (parcels.length === 0) {
      const exp = beliefs.exploreTarget();
      if (!exp) return false;
      return stepToward(world, beliefs, { key: 'mission:acquire-explore', type: 'explore', target: exp, u: 1 });
    }
    /** @param {{x:number,y:number}} c */
    const dist = (c) => Math.abs(c.x - from.x) + Math.abs(c.y - from.y);
    const nearest = parcels.reduce((a, b) => (dist(a) <= dist(b) ? a : b));
    return stepToward(world, beliefs, { key: `mission:acquire:${nearest.id}`, type: 'go_pick_up', target: { x: nearest.x, y: nearest.y }, id: nearest.id, u: 1 });
  }
  if (atTarget) {
    // Allow observers to see the parcel at the target before dropping it.
    if (!goal.settleUntil) {
      goal.settleUntil = Date.now() + params.moveMs * 2;
      return false;
    }
    if (Date.now() < goal.settleUntil) return false;
    const dropped = await world.client.emitPutdown();
    if (dropped && dropped.length) {
      beliefs.onDeliver();
      console.log(`[mission] drop_at (${goal.target.x},${goal.target.y}) completed (+${dropped.length} parcels) | score=${world.me.score}`);
      missionGoals.shift();
    }
    return true;
  }
  return stepToward(world, beliefs, { key: 'mission:deliver', type: 'explore', target: goal.target, u: 1 });
}

/** @type {import('../bdi/deliberation.js').Option|null} */
let committed = null;

console.log(`[start] "Loqua" | model=${llm.model} prompts=${PROMPT_VERSION} | delivery=${world.deliveryTiles.length} capacity=${world.capacity} | body profile=${params.profile}`);

while (true) {
  beliefs.revise();
  policy.noteScore(world.me.score); // feeds the measured earning rate
  if (directives.halt) { await sleep(params.tick); continue; } // RED LIGHT: total freeze
  let acted = false;
  const goal = missionGoals[0];
  if (goal) {
    acted = await stepMission(goal);
  } else {
    const options = repriceHandoff(applyDirectives(generateOptions(beliefs, world, params), beliefs, directives, world).filter(notDenied));
    let next = reviseIntention(committed, options, params);
    if (next && next.type === 'go_pick_up' && next.id && next.key !== committed?.key) {
      const ok = await protocol.requestClaim(next.id);
      if (!ok) { denied.set(next.id, Date.now() + 10000); next = null; }
    }
    committed = next;
    acted = await stepToward(world, beliefs, committed);
  }
  if (!acted) await sleep(params.tick);
}
