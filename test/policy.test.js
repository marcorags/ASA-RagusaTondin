import { ConveniencePolicy } from '../llm/policy.js';
import { Directives, DirectiveAwareBeliefs, applyDirectives } from '../bdi/directives.js';

/**
 * Deterministic tests (no network, no game) for the two pieces that decide
 * WHAT the agent does rather than how: the convenience-policy arithmetic, and
 * the compilation of directives into option filters and blocked cells.
 * Run: npm run test:policy
 */
let pass = 0, fail = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`);
  if (ok) pass++; else fail++;
}

const params = /** @type {any} */ ({ moveMs: 100, obs: 5, decayMs: 1000, memory: true, opponentPrediction: false });

// --- ConveniencePolicy -------------------------------------------------------
{
  // Cold start (no evidence): prudent default rate = 1 pt/s.
  const p = new ConveniencePolicy(params);
  check('cold-start rate = 1', p.earningRate() === 1, String(p.earningRate()));

  // 1000 pts for a 15-step walk: obviously worth it.
  check('big bonus adopted', p.evaluate(1000, 15).adopt === true, JSON.stringify(p.evaluate(1000, 15)));
  // 5 pts for a 40-step walk (10s → ~10 pts of farming): not worth it.
  check('small far bonus ignored', p.evaluate(5, 40).adopt === false, JSON.stringify(p.evaluate(5, 40)));
  // Unknown reward: prudent zero → never beats a positive cost.
  check('unknown reward ignored', p.evaluate(null, 3).adopt === false, JSON.stringify(p.evaluate(null, 3)));
  // Negative reward: never adopted as a goal.
  check('negative reward ignored', p.evaluate(-1000, 2).adopt === false, JSON.stringify(p.evaluate(-1000, 2)));
}
{
  // With measured evidence: rate = Δscore/Δt reprices the same mission.
  const p = new ConveniencePolicy(params);
  p._t0 = Date.now() - 100000; // 100s of play…
  p.noteScore(0); p._score0 = 0; p.noteScore(300); // …at 3 pts/s
  check('measured rate ≈ 3', Math.abs(p.earningRate() - 3) < 0.1, String(p.earningRate()));
  // 5 pts / 40 steps is even worse at 3 pts/s…
  check('rich map: small bonus still ignored', p.evaluate(5, 40).adopt === false, '');
  // …and a 30-pt bonus 5 steps away (3s → 9 pts cost) is worth it.
  check('rich map: near medium bonus adopted', p.evaluate(30, 5).adopt === true, JSON.stringify(p.evaluate(30, 5)));
}

// --- Directives → blockedCells ----------------------------------------------
{
  const world = /** @type {any} */ ({ spawnerTiles: [], me: {}, myTile: () => ({ x: 0, y: 0 }), getParcels: () => [], getCrates: () => [], getAgents: () => [] });
  const d = new Directives();
  const b = new DirectiveAwareBeliefs(world, params, d);
  check('no directives → no extra blocks', b.blockedCells().size === 0, String(b.blockedCells().size));
  d.addForbidden([{ x: 13, y: 15 }, { x: 14, y: 15 }]);
  const cells = b.blockedCells();
  check('forbidden tiles become blocked cells', cells.has('13_15') && cells.has('14_15') && cells.size === 2, [...cells].join(' '));
}

// --- applyDirectives (L2 behavioural rules) ----------------------------------
{
  const world = /** @type {any} */ ({
    myTile: () => ({ x: 0, y: 0 }),
    deliveryTiles: [{ x: 5, y: 0 }, { x: 9, y: 9 }],
    capacity: 5,
  });
  /** Minimal beliefs stub: carrying count, carried value, free parcels with est. */
  const mkBeliefs = (/** @type {number} */ carrying, /** @type {number} */ value, /** @type {{id:string,est:number}[]} */ free = []) => /** @type {any} */ ({
    carryingCount: carrying,
    carriedValue: () => value,
    freeParcels: () => free.map((p) => ({ ...p, x: 0, y: 0 })),
  });
  const pick = (/** @type {string} */ id, /** @type {number} */ u) => /** @type {any} */ ({ key: `pick:${id}`, type: 'go_pick_up', target: { x: 1, y: 1 }, id, u });
  const deliver = /** @type {any} */ ({ key: 'deliver', type: 'go_deliver', target: { x: 5, y: 0 }, u: 1 });
  const explore = /** @type {any} */ ({ key: 'explore', type: 'explore', target: { x: 3, y: 3 }, u: 0.001 });

  // batchSize: below B → pickups only; at B → deliver only.
  const d1 = new Directives(); d1.batchSize = 3;
  let out = applyDirectives([pick('a', 5), deliver, explore], mkBeliefs(2, 40), d1, world);
  check('batch: below B → no deliver', !out.some((o) => o.type === 'go_deliver') && out.some((o) => o.type === 'go_pick_up'), JSON.stringify(out.map((o) => o.key)));
  out = applyDirectives([pick('a', 5), deliver, explore], mkBeliefs(3, 60), d1, world);
  check('batch: at B → deliver, no pickups', out.some((o) => o.type === 'go_deliver') && !out.some((o) => o.type === 'go_pick_up'), JSON.stringify(out.map((o) => o.key)));

  // deliverValueMax: empty hands → single LOWEST-value pickup kept.
  const d2 = new Directives(); d2.deliverValueMax = 10;
  out = applyDirectives([pick('rich', 9), pick('poor', 2), deliver, explore], mkBeliefs(0, 0, [{ id: 'rich', est: 30 }, { id: 'poor', est: 6 }]), d2, world);
  const picks = out.filter((o) => o.type === 'go_pick_up');
  check('valueMax: single lowest pickup', picks.length === 1 && picks[0].id === 'poor', JSON.stringify(out.map((o) => o.key)));

  // carrying above threshold → putdown gated, park on nearest delivery.
  out = applyDirectives([deliver, explore], mkBeliefs(1, 25), d2, world);
  check('valueMax: over T → deliver gated, park', !out.some((o) => o.type === 'go_deliver') && out.some((o) => o.key === 'valuemax:park' && o.target.x === 5), JSON.stringify(out.map((o) => o.key)));

  // carrying at/below threshold → deliver allowed, no more pickups.
  out = applyDirectives([pick('a', 5), deliver, explore], mkBeliefs(1, 8), d2, world);
  check('valueMax: ≤ T → deliver, no stacking', out.some((o) => o.type === 'go_deliver') && !out.some((o) => o.type === 'go_pick_up'), JSON.stringify(out.map((o) => o.key)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
