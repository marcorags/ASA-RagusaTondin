import { buildMeetProblem, MEET_DOMAIN } from '../llm/pddl-team.js';

/**
 * Deterministic tests for the joint-meet PROBLEM BUILDER. The solver call
 * itself needs the network and is exercised live; what is checked here are the
 * STRIPS encoding invariants that a wrong plan would silently depend on:
 * distinct-tile tokens, both agents placed, adjacency symmetry, goal shape.
 * Run: npm run test:pddl
 */
let pass = 0, fail = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`);
  if (ok) pass++; else fail++;
}

const keys = new Set();
for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) keys.add(`${x}_${y}`);
const canMove = () => true;
const problem = buildMeetProblem(keys, canMove, { x: 0, y: 0 }, { x: 2, y: 2 }, [{ x: 1, y: 1 }, { x: 1, y: 2 }]);

check('domain declares zonefree tokens', MEET_DOMAIN.includes('(zonefree ?t)') && MEET_DOMAIN.includes('(not (zonefree ?t))'), '');
check('domain has 8 move actions + 2 arrives', (MEET_DOMAIN.match(/:action/g) ?? []).length === 10, String((MEET_DOMAIN.match(/:action/g) ?? []).length));
check('both agents placed', problem.includes('(at1 t0_0)') && problem.includes('(at2 t2_2)'), '');
check('zone facts paired with tokens', problem.includes('(zone t1_1)') && problem.includes('(zonefree t1_1)') && problem.includes('(zone t1_2)') && problem.includes('(zonefree t1_2)'), '');
check('goal is the double rendezvous', problem.includes('(:goal (and (met1) (met2)))'), '');
check('adjacency present both directions', problem.includes('(adjr t0_0 t1_0)') && problem.includes('(adjl t1_0 t0_0)'), '');
check('9 objects on the grid', (problem.match(/t\d+_\d+/g) ?? []).some(() => true) && problem.includes('(:objects') && new Set(problem.split('(:init')[0].match(/t\d+_\d+/g)).size === 9, '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
