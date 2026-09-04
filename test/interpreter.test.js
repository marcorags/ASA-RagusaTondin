import { ReactInterpreter } from '../llm/interpreter.js';
import { createTools, calculate } from '../llm/tools.js';
import { LlmClient } from '../llm/llm-client.js';
import { normalizeMissionKind } from '../llm/prompts.js';

let pass = 0, fail = 0;
/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`);
  if (ok) pass++; else fail++;
}

/** Scripted model: returns its outputs in order, then repeats the last one. */
function mockLlm(/** @type {string[]} */ outputs) {
  let i = 0;
  return { model: 'mock', chat: async () => outputs[Math.min(i++, outputs.length - 1)] };
}

console.log('--- A) interpreter guards (mock model) ---');
const tools = createTools({ getState: () => '{"x":1,"y":2}' });

check('meet_at kind accepted directly', normalizeMissionKind('meet_at') === 'meet_at');
check('handoff kind accepted directly', normalizeMissionKind('handoff') === 'handoff');
check('stop_go kind accepted directly', normalizeMissionKind('stop_go') === 'stop_go');
check('unsupported kind becomes other', normalizeMissionKind('unsupported_kind') === 'other');

{
  const llm = mockLlm([
    'Thought: need math\nAction: calculate\nAction Input: 5*5',
    'Thought: done\nFinal Answer: 25',
  ]);
  const r = await new ReactInterpreter(llm, tools).run('Calculate 5*5');
  check('happy path answer', r.answer === '25', JSON.stringify(r.answer));
  check('happy path iterations', r.iterations === 2, String(r.iterations));
  const obs = r.trace.find((m) => m.content.startsWith('Observation:'));
  check('observation contains result', !!obs && obs.content.includes('25'), obs?.content ?? 'none');
}
{
  const llm = mockLlm(['I think the answer is twenty-five.', 'Final Answer: 25']);
  const r = await new ReactInterpreter(llm, tools).run('x');
  check('invalid format recovered', r.answer === '25', JSON.stringify(r.answer));
}
{
  const llm = mockLlm([
    'Action: calculate\nAction Input: 2+2\nFinal Answer: 5',
    'Final Answer: 4',
  ]);
  const r = await new ReactInterpreter(llm, tools).run('x');
  check('action wins over premature final', r.answer === '4', JSON.stringify(r.answer));
  check('discard is notified', r.trace.some((m) => m.content.includes('Final Answer was discarded')), '');
}
{
  const llm = mockLlm([
    'Action: calculate\nAction Input: 1+1\nAction: get_state\nAction Input: none',
    'Final Answer: 2',
  ]);
  const r = await new ReactInterpreter(llm, tools).run('x');
  const note = r.trace.find((m) => m.content.includes('only the first was executed'));
  check('multiple actions noted', !!note, '');
  check('first action executed', !!note && note.content.includes('Observation:') && note.content.includes('2'), note?.content ?? '');
}
{
  const llm = mockLlm(['Action: fly\nAction Input: none', 'Final Answer: ok']);
  const r = await new ReactInterpreter(llm, tools).run('x');
  check('unknown tool error re-fed', r.trace.some((m) => m.content.includes('unknown tool "fly"') && m.content.includes('calculate')), '');
  check('recovers after unknown tool', r.answer === 'ok', JSON.stringify(r.answer));
}
{
  const llm = mockLlm(['nonsense with no format']);
  const r = await new ReactInterpreter(llm, tools, { maxIterations: 3 }).run('x');
  check('max iterations → null', r.answer === null && r.iterations === 3, JSON.stringify(r));
}

{
  const llm = mockLlm(['Action: calculate\nInput: 3*3', 'Final Answer: 9']);
  const r = await new ReactInterpreter(llm, tools).run('x');
  check('bare "Input:" line accepted', r.trace.some((m) => m.content.includes('Observation: 9')), '');
}

{
  const llm = mockLlm(['{"kind":"answer","answer":"22"}']);
  const r = await new ReactInterpreter(llm, tools).run('x');
  check('bare JSON accepted as final', r.answer !== null && r.iterations === 1 && JSON.parse(r.answer).answer === '22', JSON.stringify(r.answer));
}

console.log('--- A2) calculate validator ---');
check('calculate missing input → format hint', calculate('none').includes('Action Input'), calculate('none'));
check('calculate ok', calculate('(5*(5+3)/2)+2') === '22', calculate('(5*(5+3)/2)+2'));
check('calculate rejects identifiers', calculate('process.exit(1)').startsWith('Error'), calculate('process.exit(1)'));
check('calculate rejects letters', calculate('2+a').startsWith('Error'), calculate('2+a'));
check('calculate rejects empty', calculate('  ').startsWith('Error'), '');
check('calculate rejects Infinity', calculate('1/0').startsWith('Error'), calculate('1/0'));

const argv = process.argv.slice(2);
if (argv[0] === '--live') {
  const models = argv.slice(1);
  if (models.length === 0) models.push('google/gemma-3-27b-it', 'qwen/qwen3-30b-a3b');
  console.log('--- B) live model probes ---');
  for (const model of models) {
    const llm = new LlmClient({ model });
    const it = new ReactInterpreter(llm, tools);
    const t0 = Date.now();
    const calc = await it.run('Calculate 5*5');
    check(`[${model}] calculate 5*5 → 25`, calc.answer?.trim() === '25', JSON.stringify(calc.answer));
    const capital = await it.run('What is the capital of Italy?');
    check(`[${model}] capital → Rome (bare)`, /^rome$/i.test(capital.answer?.trim() ?? ''), JSON.stringify(capital.answer));
    console.log(`      (${Date.now() - t0}ms total, ${llm.usage.completion} completion tokens over ${llm.usage.calls} calls)`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
