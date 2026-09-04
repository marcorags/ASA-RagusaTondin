import { TeamProtocol } from '../core/team-protocol.js';

/**
 * Deterministic tests for the team protocol: handshake (including rejection
 * of an impostor with the wrong secret), claim grant/deny with the
 * deterministic tie-break under a simultaneous race, and directive/belief
 * routing. Everything runs on an in-memory two-endpoint bus, so the race that
 * matters can be triggered on purpose instead of waited for.
 * Run: npm run test:team
 */
let pass = 0, fail = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`);
  if (ok) pass++; else fail++;
}
const tick = () => new Promise((r) => setTimeout(r, 60)); // > claim delay (30ms)

/** In-memory chat bus: endpoints deliver to each other like the server would. */
function makeBus() {
  /** @type {Map<string, ((id:string,name:string,msg:any,reply?:any)=>void)[]>} */
  const listeners = new Map();
  const endpoint = (/** @type {string} */ id) => ({
    id,
    onMsg(/** @type {any} */ cb) { listeners.set(id, [...(listeners.get(id) ?? []), cb]); },
    async emitSay(/** @type {string} */ to, /** @type {any} */ msg) {
      for (const cb of listeners.get(to) ?? []) cb(id, id, msg, undefined);
      return 'successful';
    },
    async emitAsk(/** @type {string} */ to, /** @type {any} */ msg) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 1000);
        for (const cb of listeners.get(to) ?? []) cb(id, id, msg, (/** @type {any} */ r) => { clearTimeout(timer); resolve(r); });
      });
    },
    async emitShout(/** @type {any} */ msg) {
      for (const [other, cbs] of listeners) if (other !== id) for (const cb of cbs) cb(id, id, msg, undefined);
      return 'successful';
    },
  });
  return endpoint;
}

process.env.TEAM_SECRET = 'test-secret';

// --- Handshake ---------------------------------------------------------------
{
  const bus = makeBus();
  const a = new TeamProtocol(bus('aaa'), { name: 'A' });
  const b = new TeamProtocol(bus('bbb'), { name: 'B' });
  a.attach('aaa'); b.attach('bbb');
  await tick(); await tick();
  check('handshake pairs both sides', a.teammateId === 'bbb' && b.teammateId === 'aaa', `a→${a.teammateId} b→${b.teammateId}`);
}
{
  // Impostor: same bus, WRONG secret → its acks must be rejected.
  const bus = makeBus();
  const a = new TeamProtocol(bus('aaa'), { name: 'A' });
  const evil = new TeamProtocol(bus('eee'), { name: 'Evil', secret: 'wrong-secret' });
  a.attach('aaa'); evil.attach('eee');
  await tick(); await tick();
  check('impostor with wrong secret NOT paired', a.teammateId === null, `a→${a.teammateId}`);
}

// --- Claims -------------------------------------------------------------------
{
  const bus = makeBus();
  const a = new TeamProtocol(bus('aaa'), { name: 'A' });
  const b = new TeamProtocol(bus('bbb'), { name: 'B' });
  a.attach('aaa'); b.attach('bbb');
  await tick(); await tick();

  const g1 = await a.requestClaim('p1');
  check('first claim granted', g1 === true, String(g1));
  const g2 = await b.requestClaim('p1');
  check('conflicting claim denied', g2 === false, String(g2));
  const g3 = await b.requestClaim('p2');
  check('other parcel granted', g3 === true, String(g3));

  // Deterministic tie-break: both optimistically own p3, then both ask.
  a.claims.set('p3', { owner: 'aaa', at: Date.now() });
  b.claims.set('p3', { owner: 'bbb', at: Date.now() });
  const [ra, rb] = await Promise.all([a.requestClaim('p3'), b.requestClaim('p3')]);
  check('symmetric race → exactly one winner (lower id)', ra === true && rb === false, `a=${ra} b=${rb}`);
}

// --- Directive / belief routing (only from the authenticated teammate) --------
{
  const bus = makeBus();
  /** @type {any[]} */ const gotDirectives = [];
  /** @type {any[]} */ const gotBeliefs = [];
  const a = new TeamProtocol(bus('aaa'), { name: 'A', onDirective: (p) => gotDirectives.push(p), onBelief: (p) => gotBeliefs.push(p) });
  const b = new TeamProtocol(bus('bbb'), { name: 'B' });
  const evil = { ...bus('eee') };
  a.attach('aaa'); b.attach('bbb');
  await tick(); await tick();

  b.sendDirective({ forbidden: [{ x: 1, y: 2 }] });
  b.sendBelief({ parcels: [{ id: 'p9', x: 3, y: 4, reward: 20 }] });
  await tick();
  check('directive routed to hook', gotDirectives.length === 1 && gotDirectives[0].forbidden[0].x === 1, JSON.stringify(gotDirectives));
  check('belief routed to hook', gotBeliefs.length === 1, JSON.stringify(gotBeliefs));

  // A non-teammate sending a directive must be ignored.
  await evil.emitSay('aaa', { v: 1, type: 'directive', from: 'eee', payload: { forbidden: [{ x: 9, y: 9 }] } });
  await tick();
  check('directive from stranger ignored', gotDirectives.length === 1, String(gotDirectives.length));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
