import { connectWorld, sleep } from '../core/world.js';
import { bfsToNearest } from '../core/pathfinding.js';
import { TeamProtocol } from '../core/team-protocol.js';
import { resolveStrategy } from '../bdi/strategy.js';
import { generateOptions, reviseIntention } from '../bdi/deliberation.js';
import { stepToward } from '../bdi/plans.js';
import { Directives, DirectiveAwareBeliefs, applyDirectives } from '../bdi/directives.js';

/**
 * AGENT A, TEAM EDITION — "Cassandra_T", the BDI half of the coordinated pair.
 *
 * Cassandra stays untouched as the standalone BDI deliverable; this agent adds
 * the team layer on top of the same core, and keeps FULL BDI autonomy on the
 * standard mission. Coordination constrains her play, it does not replace it:
 * with no teammate paired she is simply Cassandra.
 *
 * The team layer, in three parts:
 *
 *  - `TeamProtocol`: authenticated pairing with the LLM agent, Contract-Net
 *    -lite parcel CLAIMS so the two never converge on the same target,
 *    incoming DIRECTIVES (the LLM interprets a mission, this agent adapts —
 *    forbidden tiles, batch size, value caps), and BELIEF exchange, which
 *    effectively doubles the pair's sensing;
 *  - the SAME directive machinery the LLM agent's own body uses
 *    (DirectiveAwareBeliefs + applyDirectives): one implementation, two
 *    consumers, no forked behaviour that could drift apart;
 *  - explicit TASKS assigned by the coordinator for the missions that need two
 *    bodies in specific places (rendezvous, parcel handoff).
 *
 * Claims are requested only when SWITCHING to a new pickup intention, not on
 * every tick, so the bounded ≤1s await never sits in the movement path. A
 * denied parcel is avoided for a cooldown and then contested again, because by
 * then the teammate has probably moved on.
 */

const world = await connectWorld('Cassandra_T');
const params = resolveStrategy(world.config);
const directives = new Directives();
const beliefs = new DirectiveAwareBeliefs(world, params, directives);

/**
 * Explicit tasks assigned by the coordinator: goto+hold (rendezvous) and
 * drop_at (handoff drops). Same livelock defenses as Loqua's mission goals:
 * deadline + settle beat before putdown.
 * @type {{kind:'goto'|'drop_at', target:{x:number,y:number}, deadline:number, holdMs?:number, holdUntil?:number, settleUntil?:number}[]}
 */
const taskGoals = [];
/** Handoff picker mode: where to drop the cargo instead of delivering. @type {{x:number,y:number}|null} */
let handoffDrop = null;
/**
 * After a handoff drop, the picker must yield the just-dropped parcels to
 * Loqua. While pending, only pickups on this tile are filtered out.
 * @type {{x:number,y:number, observed:boolean}|null}
 */
let pendingHandoffTransfer = null;

/** @param {{x:number,y:number}} a @param {{x:number,y:number}} b */
const sameTile = (a, b) => a.x === b.x && a.y === b.y;

function refreshHandoffTransfer() {
  if (!pendingHandoffTransfer) return;
  const parcelsHere = beliefs.parcelsAt(pendingHandoffTransfer);
  if (parcelsHere.length > 0) {
    pendingHandoffTransfer.observed = true;
    return;
  }
  if (pendingHandoffTransfer.observed) {
    console.log(`[team] handoff transfer progressed at (${pendingHandoffTransfer.x},${pendingHandoffTransfer.y}) - picker resumes local pickups`);
    pendingHandoffTransfer = null;
  }
}

const protocol = new TeamProtocol(world.client, {
  name: 'Cassandra_T',
  onDirective: (payload) => {
    if (Array.isArray(payload?.forbidden)) directives.addForbidden(payload.forbidden);
    if (Number.isInteger(payload?.batchSize)) directives.batchSize = Math.min(payload.batchSize, world.capacity);
    if (Number.isInteger(payload?.deliverValueMax)) directives.deliverValueMax = payload.deliverValueMax;
    if (payload?.stopGoArmed === true) directives.stopGoArmed = true;
    if (typeof payload?.halt === 'boolean') { directives.halt = payload.halt; console.log(`[team] ${payload.halt ? 'RED LIGHT → halted' : 'GREEN LIGHT → resumed'}`); }
    console.log(`[team] directive received from Loqua → active: ${directives.describe()}`);
  },
  onTask: (payload) => {
    if (payload?.kind === 'meet_at' && Number.isInteger(payload.x) && Number.isInteger(payload.y)) {
      const r = Number.isInteger(payload.maxDistance) ? payload.maxDistance : 3;
      const from = world.myTile();
      // PDDL-assigned tile (joint plan): use it directly when valid/reachable.
      if (Number.isInteger(payload.assigned?.x) && Number.isInteger(payload.assigned?.y) && !world.isWall(payload.assigned.x, payload.assigned.y)) {
        const t = { x: payload.assigned.x, y: payload.assigned.y };
        const p = bfsToNearest(from, [t], world.makeCanMove(beliefs.blockedCells()));
        if (p) {
          taskGoals.push({ kind: 'goto', target: t, deadline: Date.now() + Math.max(90000, (p.length - 1) * params.moveMs * 5), holdMs: Number(payload.holdMs) || 60000 });
          console.log(`[team] task accepted: meet at PDDL-assigned (${t.x},${t.y}) and hold`);
          return;
        }
      }
      /** @type {{x:number,y:number}[]} */
      const candidates = [];
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r + Math.abs(dx); dy <= r - Math.abs(dx); dy++) {
          const c = { x: payload.x + dx, y: payload.y + dy };
          if (c.x >= 0 && c.y >= 0 && c.x < world.worldMap.width && c.y < world.worldMap.height && !world.isWall(c.x, c.y)) candidates.push(c);
        }
      }
      const path = candidates.length ? bfsToNearest(from, candidates, world.makeCanMove(beliefs.blockedCells())) : null;
      if (!path) { console.log('[team] task meet_at: unreachable → declined'); return; }
      const target = path[path.length - 1];
      taskGoals.push({ kind: 'goto', target, deadline: Date.now() + Math.max(90000, (path.length - 1) * params.moveMs * 5), holdMs: Number(payload.holdMs) || 60000 });
      console.log(`[team] task accepted: meet at (${target.x},${target.y}) and hold`);
      return;
    }
    if (payload?.kind === 'handoff-picker' && Number.isInteger(payload.dropZone?.x)) {
      handoffDrop = { x: payload.dropZone.x, y: payload.dropZone.y };
      console.log(`[team] task accepted: PICKER role — dropping cargo at (${handoffDrop.x},${handoffDrop.y}) instead of delivering`);
      return;
    }
  },
  onBelief: (payload) => {
    if (!Array.isArray(payload?.parcels)) return;
    let added = 0;
    for (const p of payload.parcels) {
      if (typeof p?.id !== 'string' || !Number.isInteger(p.x) || !Number.isInteger(p.y)) continue;
      if (!beliefs.parcels.has(p.id)) {
        beliefs.parcels.set(p.id, { id: p.id, x: p.x, y: p.y, reward0: Number(p.reward) || 0, seenAt: Date.now() });
        added++;
      }
    }
    if (added > 0) console.log(`[team] belief exchange: +${added} parcels from Loqua's view`);
  },
});
protocol.attach(world.me.id);

/** Parcels denied by a claim, avoided for a cooldown. @type {Map<string, number>} */
const denied = new Map();
const notDenied = (/** @type {import('../bdi/deliberation.js').Option} */ o) =>
  o.type !== 'go_pick_up' || !o.id || (denied.get(o.id) ?? 0) < Date.now();

// Periodic belief sharing: parcels we see + our position (the joint
// planner needs to know where we are).
setInterval(() => {
  const parcels = beliefs.freeParcels().slice(0, 8).map((p) => ({ id: p.id, x: p.x, y: p.y, reward: p.est }));
  protocol.sendBelief({ parcels, pos: world.myTile() });
}, 5000);

/**
 * One step of the active team task (mirrors Loqua's stepMission: deadline,
 * hold-at-target for rendezvous, settle-then-putdown for handoff drops).
 * @param {typeof taskGoals[0]} goal
 * @returns {Promise<boolean>}
 */
async function stepTask(goal) {
  if (Date.now() > goal.deadline) {
    console.log(`[team] task ${goal.kind} → (${goal.target.x},${goal.target.y}) abandoned (deadline)`);
    taskGoals.shift();
    return false;
  }
  const from = world.myTile();
  const atTarget = from.x === goal.target.x && from.y === goal.target.y;
  if (goal.kind === 'goto') {
    if (atTarget) {
      if (goal.holdMs) {
        if (!goal.holdUntil) { goal.holdUntil = Date.now() + goal.holdMs; console.log(`[team] holding at (${from.x},${from.y}) for ${goal.holdMs / 1000}s`); }
        if (Date.now() < goal.holdUntil) return false;
      }
      console.log(`[team] task goto (${goal.target.x},${goal.target.y}) completed`);
      taskGoals.shift();
      return true;
    }
    return stepToward(world, beliefs, { key: 'task:goto', type: 'explore', target: goal.target, u: 1 });
  }
  // drop_at (handoff): walk, settle one beat (observer race, see stepMission), putdown.
  if (atTarget) {
    if (!goal.settleUntil) { goal.settleUntil = Date.now() + params.moveMs * 2; return false; }
    if (Date.now() < goal.settleUntil) return false;
    const dropped = await world.client.emitPutdown();
    if (dropped && dropped.length) {
      beliefs.onDeliver();
      pendingHandoffTransfer = { x: from.x, y: from.y, observed: false };
      console.log(`[team] handoff drop: ${dropped.length} parcel(s) left at (${from.x},${from.y}) for Loqua`);
      taskGoals.shift();
    }
    return true;
  }
  return stepToward(world, beliefs, { key: 'task:drop', type: 'explore', target: goal.target, u: 1 });
}

/** @type {import('../bdi/deliberation.js').Option|null} */
let committed = null;

console.log(`[start] "Cassandra_T" | delivery=${world.deliveryTiles.length} capacity=${world.capacity} | team=${process.env.TEAM_SECRET ? 'on' : 'OFF (no TEAM_SECRET)'}`);

while (true) {
  beliefs.revise();
  if (directives.halt) { await sleep(params.tick); continue; } // RED LIGHT: total freeze
  // Assigned team task first, then handoff bookkeeping, then standard play.
  const task = taskGoals[0];
  if (task) {
    const acted = await stepTask(task);
    if (!acted) await sleep(params.tick);
    continue;
  }
  if (handoffDrop && beliefs.carryingCount >= Math.min(3, world.capacity)) {
    taskGoals.push({ kind: 'drop_at', target: handoffDrop, deadline: Date.now() + 60000 });
    continue;
  }
  let options = applyDirectives(generateOptions(beliefs, world, params), beliefs, directives, world).filter(notDenied);
  refreshHandoffTransfer();
  // Picker role: never deliver yourself — the whole point is that Loqua does.
  if (handoffDrop) options = options.filter((o) => o.type !== 'go_deliver');
  if (pendingHandoffTransfer) {
    options = options.filter((o) => !(o.type === 'go_pick_up' && sameTile(o.target, pendingHandoffTransfer)));
  }
  let next = reviseIntention(committed, options, params);
  // Claim before committing to a NEW pickup (CNP-lite, bounded by the ask's 1s).
  if (next && next.type === 'go_pick_up' && next.id && next.key !== committed?.key) {
    const ok = await protocol.requestClaim(next.id);
    if (!ok) {
      denied.set(next.id, Date.now() + 10000);
      console.log(`[team] claim denied for ${next.id} → picking something else`);
      next = null; // re-deliberate next tick without this parcel
    }
  }
  committed = next;
  const acted = await stepToward(world, beliefs, committed);
  if (!acted) await sleep(params.tick);
}
