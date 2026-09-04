import { connectWorld, sleep } from '../core/world.js';
import { bfsToNearest } from '../core/pathfinding.js';
import { resolveStrategy } from '../bdi/strategy.js';
import { generateOptions, reviseIntention } from '../bdi/deliberation.js';
import { stepToward } from '../bdi/plans.js';
import { LlmClient } from '../llm/llm-client.js';
import { createTools } from '../llm/tools.js';
import { ReactInterpreter, parseJsonAnswer } from '../llm/interpreter.js';
import { missionSystem, PROMPT_VERSION } from '../llm/prompts.js';
import { MissionInbox } from '../llm/inbox.js';
import { ConveniencePolicy } from '../llm/policy.js';
import { Directives, DirectiveAwareBeliefs, applyDirectives } from '../bdi/directives.js';
import { TeamProtocol } from '../core/team-protocol.js';
import { planMeet } from '../llm/pddl-team.js';

/**
 * AGENT B — "Loqua", the LLM agent.
 *
 * BDI BODY + LLM HEAD. The organising idea is that an LLM agent here is not an
 * LLM that plays the game; it is an LLM that INTERPRETS language and controls
 * a BDI agent that plays the game. The two run at completely different speeds,
 * and keeping them separate is the whole design:
 *
 *  - the BODY is Cassandra's deterministic loop — the very same beliefs,
 *    deliberation and plan modules — playing the standard mission at clock
 *    speed, always. The LLM is NEVER in the movement path. A model that takes
 *    one second to answer cannot be consulted between two steps that take
 *    fifty milliseconds each;
 *  - the HEAD is asynchronous: MissionInbox (filtered, serialized) →
 *    ReactInterpreter (natural language → MissionSpec JSON, tool-augmented) →
 *    an adoption decision → goals compiled into something the body executes.
 *
 * Stated in BDI vocabulary, a special mission is a DESIRE injected through
 * natural language: the LLM is the interpretation function that turns text
 * into a candidate desire, the convenience policy is the deliberation step
 * that decides whether to adopt it, and execution is ordinary means-ends
 * reasoning. Nothing about the architecture changes because the input arrived
 * as a sentence.
 *
 * Between those two speeds sits a third, faster than both: REFLEXES. Some
 * rules cost points on every tick they are not yet understood — walking onto a
 * forbidden tile, moving during a red light — and waiting for an
 * interpretation round is measurably expensive. Those get a zero-latency
 * textual heuristic that acts immediately, with the LLM confirming or refining
 * afterwards. Reactive layer under a deliberative one, applied to the language
 * channel.
 */

const world = await connectWorld('Loqua');
const params = resolveStrategy(world.config);
const directives = new Directives();
const beliefs = new DirectiveAwareBeliefs(world, params, directives);
const policy = new ConveniencePolicy(params);
const VERBOSE = process.env.DEBUG_LLM === '1';

// --- HEAD: tools bound to live state, interpreter, inbox --------------------

const tools = createTools({
  // Concise state synthesis, never a full map dump. The ground truth lives in
  // the BeliefStore; the model gets only what a mission might plausibly need.
  // Context is a budget: everything in here is paid for on every LLM call.
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

/**
 * Validate/normalize a raw MissionSpec coming from the model. The model's
 * output is UNTRUSTED: unknown kinds collapse to 'other', and coordinates are
 * kept only if they are integers inside the map bounds. Validation is not
 * politeness towards a fallible model — it is the boundary where an
 * attacker-writable chat message stops being able to influence anything.
 * @param {any} raw
 */
function validateSpec(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = ['goto', 'drop_at', 'answer', 'avoid', 'deliver_exactly', 'deliver_value_max', 'other'].includes(raw.kind) ? raw.kind : 'other';
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

/**
 * Adopted atomic-mission goals, executed by the body (FIFO; one active).
 * `deadline` exists because a goal that cannot complete must EXPIRE rather
 * than block the agent forever — an unreachable mission target would otherwise
 * freeze a perfectly healthy agent indefinitely. `settleUntil`
 * handles an OBSERVER RACE found live: mission agents detect deliveries from
 * their frame-rate sensing of parcel positions — dropping the same instant we
 * land records the parcel one step short of the target; landing, settling one
 * movement-beat, then acting gives the observer a frame with the parcel at
 * integer target coordinates. `gain` (expected points, from the policy) ranks
 * simultaneous missions. `holdMs` (meet_at): after arrival, HOLD the position
 * for that long before completing (the rendezvous requires waiting).
 * @type {{kind:'goto'|'drop_at', target:{x:number,y:number}, senderId:string, deadline:number, gain:number, settleUntil?:number, holdMs?:number, holdUntil?:number}[]}
 */
const missionGoals = [];

/**
 * HAZARD REFLEX — a measured lesson. Between a penalty mission being shouted
 * and its LLM interpretation coming back (8 to 30 seconds), the agent crossed
 * the forbidden tiles twice and lost 2000 points. Interpretation latency has a
 * price, and for prohibitions that price is paid per step.
 *
 * So prohibitions get a REFLEX path: a zero-latency textual heuristic adopts a
 * PROVISIONAL avoidance immediately, and the LLM confirms or refines it a few
 * seconds later. The heuristic is deliberately conservative — a false positive
 * costs a few needlessly blocked tiles, a false negative costs a heavy penalty
 * on every single step taken in the meantime.
 * @param {string} text
 */
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

/** Head pipeline: interpret → decide → compile (runs serialized by the inbox). */
async function handleMission(/** @type {string} */ text, /** @type {string} */ senderId, /** @type {string} */ senderName) {
  console.log(`[mission] from ${senderName}(${senderId}): ${text.slice(0, 120)}`);
  hazardReflex(text);
  const t0 = Date.now();
  const result = await interpreter.run(`Message received:\n<<<${text}>>>`);
  const spec = validateSpec(parseJsonAnswer(result.answer));
  console.log(`[mission] interpreted in ${Date.now() - t0}ms, ${result.iterations} turn(s) → ${JSON.stringify(spec)}`);
  if (!spec) { console.log('[mission] uninterpretable → ignored (agent keeps playing)'); return; }

  // SCHEMA-DRIVEN KIND RESCUE (measured on gemma, twice): the model fills the
  // discriminating parameters correctly but labels the kind "other" (stop_go
  // and meet_at both hit this). When the parameter SHAPE identifies the kind
  // unambiguously — only meet_at carries a point, only deliver_exactly a
  // count, only deliver_value_max a threshold — the redundant label is
  // corrected in code, not re-asked to the model.
  if (spec.kind === 'other') {
    if (spec.point) spec.kind = 'meet_at';
    else if (spec.count) spec.kind = 'deliver_exactly';
    else if (spec.threshold !== null) spec.kind = 'deliver_value_max';
    // handoff has NO discriminating parameter — rescue on the TEXT shape
    // (pick + deliver + another/other agent), like the hazard reflex does.
    // Needed because the label is provider-nondeterministic: same model,
    // same prompt, temperature 0 → "handoff" offline, "other" live (measured).
    else if (/pick/i.test(text) && /deliver/i.test(text) && /\b(another|other|different)\s+agent/i.test(text)) spec.kind = 'handoff';
    if (spec.kind !== 'other') console.log(`[mission] kind rescued: other → ${spec.kind} (redundant evidence: parameter/text shape)`);
  }

  // Lenient reply rule: a non-null `answer` signals a reply is expected even
  // if the model mislabeled the kind (measured on llama: computed "22" but
  // classified 'other'). Belt and braces over taxonomy purity.
  if (spec.answer && (spec.kind === 'answer' || spec.kind === 'other')) {
    // BARE string to the sender: the asking agent compares the reply against
    // an exact lowercase match, so any wrapping text loses the reward.
    const res = await world.client.emitSay(senderId, spec.answer);
    console.log(`[mission] answered "${spec.answer}" → ${res}`);
    if (spec.kind === 'answer') return;
  }

  // Penalty missions compile to an AVOIDANCE DIRECTIVE, whatever surface
  // form they took: an explicit 'avoid', or a goto/drop_at whose reward is
  // negative (the mission agents implement "do not go through X" as a GoTo
  // with negative bonus — the listed coordinates ARE the penalty tiles).
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

  // Persistent rules compile to BEHAVIOURAL directives. Adoption rule: a
  // persistent bonus rule with non-negative (or unknown) reward is adopted —
  // its counterfactual cost cannot be priced online (it reshapes the whole
  // farming pattern), and pricing it online would be guesswork.
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

  // --- Team missions: the ones that need two bodies, not one ---------------
  if (spec.kind === 'stop_go') {
    // Penalty-avoidance rule: always adopt (like avoidance). The RED/GREEN
    // state changes are handled by stopGoReflex at ~0ms from here on.
    directives.stopGoArmed = true;
    protocol.sendDirective({ stopGoArmed: true });
    console.log(`[policy] stop-go armed (persistent, forwarded) — movement now gated by RED/GREEN messages | active: ${directives.describe()}`);
    return;
  }
  if (spec.kind === 'meet_at' && spec.point) {
    // Both agents converge within maxDistance of the point and WAIT.
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
    // Convenience: gain vs (walk + hold) priced at the measured rate.
    const seconds = ((path.length - 1) * params.moveMs) / 1000 + holdMs / 1000;
    const cost = policy.earningRate() * seconds;
    if ((spec.rewardHint ?? 0) <= cost * 1.2) {
      console.log(`[policy] meet_at ignored: gain ${spec.rewardHint ?? 0} ≤ cost ~${Math.round(cost)} pts (${Math.round(seconds)}s incl. wait)`);
      return;
    }
    // PDDL in Agent B: try the JOINT plan first — the planner assigns the two
    // (distinct) zone tiles minimizing total travel; A* walks the legs. This
    // runs in the async head (inbox-serialized), never in the clock path.
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
    // Role split: teammate = PICKER (drops its cargo on a non-delivery
    // tile adjacent to a delivery), Loqua = DELIVERER (her standard play
    // scoops the drop zone via sensing/belief exchange and delivers — her
    // pickup is not "initial", so every such delivery pays the team bonus).
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
    // Reachability check AT ADOPTION: pick the nearest reachable option by
    // true path length. A mission whose targets have no route right now is
    // declined outright rather than adopted and left to stall the agent —
    // deciding late what could be decided early is how livelocks start.
    const from = world.myTile();
    const canMove = world.makeCanMove(beliefs.blockedCells());
    const path = bfsToNearest(from, spec.options, canMove);
    if (!path) {
      console.log(`[mission] no reachable target among ${JSON.stringify(spec.options)} → ignored`);
      return;
    }
    // Convenience policy: expected gain versus the opportunity cost of
    // pausing the standard mission, priced at the MEASURED earning rate.
    const v = policy.evaluate(spec.rewardHint, path.length - 1);
    if (!v.adopt) {
      console.log(`[policy] ignored: gain ${v.gain} ≤ opportunity cost ~${v.cost} pts (${v.seconds}s at ${v.rate} pts/s of standard play)`);
      return;
    }
    const target = path[path.length - 1];
    // Deadline proportional to the path (5× slack) with a 30s floor: expired
    // goals are abandoned and standard play resumes.
    const deadline = Date.now() + Math.max(30000, (path.length - 1) * params.moveMs * 5);
    missionGoals.push({ kind: spec.kind, target, senderId, deadline, gain: v.gain });
    // Multiple simultaneous missions: highest expected gain first.
    missionGoals.sort((a, b) => b.gain - a.gain);
    console.log(`[policy] adopted ${spec.kind} → (${target.x},${target.y}): gain ${v.gain} > cost ~${v.cost} pts (path ${path.length - 1} steps, deadline +${Math.round((deadline - Date.now()) / 1000)}s)`);
    return;
  }

  console.log(`[mission] kind=${spec.kind} → ignored (${spec.reason})`);
}

// --- TEAM: authenticated channel with the BDI teammate ---------------------
// Loqua is the mission COORDINATOR, and this follows from the architecture
// rather than being a choice: she is the only one of the pair who can read
// natural language, so she is the only one who can learn what the rules are.
// Compiled directives are therefore forwarded so the whole team adapts;
// claims prevent double pickups on the standard mission; belief exchange
// roughly doubles the pair's effective sensing.
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

/**
 * Handoff drop zone (when the handoff mission is active): pickups THERE are
 * repriced with the expected team bonus — the utility must know that those
 * deliveries pay +bonus, or the deliverer never bothers to travel (measured:
 * 3×8 parcels dropped, zero scooped before the repricing).
 * @type {{x:number,y:number}|null}
 */
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

/**
 * STOP-GO REFLEX: once the red-light/green-light mission is armed, the state
 * messages gate movement at reflex speed. Every move made during a red light
 * costs points, so spending an LLM turn per state change would bleed exactly
 * the way the avoidance case did before it got a reflex. State messages START
 * with the colour, which is what separates them from the arming announcement
 * that merely mentions both colours mid-sentence.
 * Runs on the inbox RAW hook: state changes repeat and must bypass dedupe.
 * @param {string} text
 */
function stopGoReflex(text) {
  const t = text.trim();
  // ARMING is a reflex too (measured: the LLM understood the announce —
  // reason "red-light green-light gating" — but emitted kind:"other"; and a
  // rule whose violations are per-move cannot wait for a model roundtrip).
  // The announce mentions BOTH colors + a stop/wait/penalty keyword; so do
  // the state messages ("RED LIGHT! … until the next green light!"), which
  // conveniently arm late joiners as well.
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

// --- BODY: one mission-goal step (reuses Cassandra's means-ends executor) ---

/**
 * Execute one step of the active atomic-mission goal. Returns true if an
 * action was taken; removes the goal from the queue when completed.
 * `stepToward` is reused as-is: 'explore' moves toward a target tile,
 * 'go_pick_up' walks-and-picks — no fork of the BDI executor.
 * @param {{kind:'goto'|'drop_at', target:{x:number,y:number}, senderId:string, deadline:number, gain:number, settleUntil?:number, holdMs?:number, holdUntil?:number}} goal
 * @returns {Promise<boolean>}
 */
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
        // Rendezvous semantics: arriving is not enough, we WAIT (meet_at).
        if (!goal.holdUntil) { goal.holdUntil = Date.now() + goal.holdMs; console.log(`[mission] holding at (${from.x},${from.y}) for ${goal.holdMs / 1000}s`); }
        if (Date.now() < goal.holdUntil) return false;
      }
      console.log(`[mission] goto (${goal.target.x},${goal.target.y}) completed`);
      missionGoals.shift();
      return true; // reaching the tile IS the completion (rewards are observed server-side)
    }
    return stepToward(world, beliefs, { key: 'mission:goto', type: 'explore', target: goal.target, u: 1 });
  }

  // drop_at: acquire a parcel first, then drop it on the target tile.
  if (beliefs.carryingCount === 0) {
    const parcels = beliefs.freeParcels();
    if (parcels.length === 0) {
      // No parcel in belief: fall back to standard exploration until one shows up.
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
    // Settle one movement-beat before dropping (observer race, see typedef).
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

// --- Control loop: body always runs; head acts through compiled goals -------

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
    // Standard play, shaped by the persistent directives, the team claims
    // (no double pickups) and the handoff repricing.
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
