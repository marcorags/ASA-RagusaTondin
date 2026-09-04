import { solverSystem, forModel } from './prompts.js';

/**
 * ReAct interpreter — the LLM-PLANNER of the agent: it turns an objective
 * expressed in natural language into a structured, validated specification the
 * rest of the system can act on. A textual Thought / Action / Action Input /
 * Observation loop, with the defensive runtime checks a text protocol needs,
 * because the model's output is a PROPOSAL and is never trusted:
 *
 *  - anchored regexes (one directive per line, Final Answer multiline);
 *  - if a turn contains BOTH an Action and a Final Answer, the Action wins
 *    and the premature answer is discarded — the model has not finished
 *    gathering evidence, so its conclusion is not yet worth anything;
 *  - if a turn contains N Actions, only the FIRST is executed and the model
 *    is told so via the observation;
 *  - invalid format → the error is re-fed as an observation, so the model
 *    self-corrects instead of the whole run being thrown away;
 *  - hard `maxIterations`: exhausted → `answer: null` and the CALLER decides
 *    the fallback (our rule: ignore the mission, keep playing);
 *  - per-run SCRATCHPAD: the Thought/Action/Observation chain lives in a
 *    local message array, so the caller's own memory stays clean.
 *
 * The full trace is returned (and optionally logged live with `verbose`): it
 * is what makes the reasoning inspectable during a demo, and what the
 * verbose-vs-minimal token comparison is measured on.
 */

/**
 * Parse a Final Answer expected to be a JSON object. Models wrap JSON in
 * markdown fences no matter what the prompt says, so parsing has to be
 * defensive: strip fences, find the outermost braces, parse. Returns null on
 * failure — the caller decides (here: the mission collapses to kind 'other').
 * @param {string|null} text
 * @returns {any|null}
 */
export function parseJsonAnswer(text) {
  if (!text) return null;
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

const ACTION_RE = /^Action:\s*(.+)$/im;
// Tolerant on the input line: models (measured on llama-3.3-70b) often write
// "Input:" instead of "Action Input:" — rejecting that only sends them into
// a misleading-feedback loop. Accept both; the strict form stays in prompts.
const ACTION_INPUT_RE = /^(?:Action\s+)?Input:\s*(.+)$/im;
const FINAL_RE = /^Final Answer:\s*([\s\S]*)$/im;
const ACTION_COUNT_RE = /^Action:/gim;

export class ReactInterpreter {
  /**
   * @param {{ chat: (messages:any[]) => Promise<string>, model?: string }} llm - LlmClient or mock
   * @param {{ registry: Record<string, (input:string) => string|Promise<string>>, catalog: string }} tools
   * @param {{ maxIterations?: number, verbose?: boolean, systemPrompt?: string }} [opts]
   */
  constructor(llm, tools, opts = {}) {
    this.llm = llm;
    this.tools = tools;
    this.maxIterations = opts.maxIterations ?? 8;
    this.verbose = opts.verbose ?? process.env.DEBUG_LLM === '1';
    const base = opts.systemPrompt ?? solverSystem(tools.catalog);
    this.systemPrompt = forModel(base, llm.model ?? '');
  }

  /**
   * Solve one request. Returns `answer: null` when the model never produced
   * a valid Final Answer within maxIterations (caller decides the fallback).
   * @param {string} userInput
   * @param {{ context?: string }} [opts] - optional extra context appended to the request
   * @returns {Promise<{ answer: string|null, iterations: number, trace: {role:string, content:string}[] }>}
   */
  async run(userInput, opts = {}) {
    /** @type {{role:'system'|'user'|'assistant', content:string}[]} */
    const scratchpad = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: opts.context ? `${userInput}\n\nContext:\n${opts.context}` : userInput },
    ];
    const log = (/** @type {string} */ line) => { if (this.verbose) console.log(`[react] ${line}`); };

    for (let i = 0; i < this.maxIterations; i++) {
      const text = await this.llm.chat(scratchpad);
      scratchpad.push({ role: 'assistant', content: text });
      log(text.replaceAll('\n', ' | '));

      const action = ACTION_RE.exec(text);
      const final = FINAL_RE.exec(text);

      if (action) {
        // An Action wins over a premature Final Answer in the same turn.
        const nActions = (text.match(ACTION_COUNT_RE) ?? []).length;
        const name = action[1].trim();
        const input = ACTION_INPUT_RE.exec(text)?.[1]?.trim() ?? 'none';
        const tool = this.tools.registry[name];
        let observation = tool
          ? String(await tool(input))
          : `Error: unknown tool "${name}". Available tools: ${Object.keys(this.tools.registry).join(', ')}.`;
        if (nActions > 1) observation = `Note: you output ${nActions} Actions; only the first was executed. ${observation}`;
        if (final) observation = `Note: you output both an Action and a Final Answer; the Final Answer was discarded. ${observation}`;
        log(`observation: ${observation}`);
        scratchpad.push({
          role: 'user',
          content: `Observation: ${observation}\nContinue. Output exactly one Action or one Final Answer.`,
        });
        continue;
      }

      if (final) {
        return { answer: final[1].trim(), iterations: i + 1, trace: scratchpad };
      }

      // Measured tolerance (qwen3): when asked for a JSON spec, the model may
      // emit the bare JSON with no "Final Answer:" prefix — and repeat it
      // verbatim on every format-error retry (8 wasted calls). A message that
      // IS a well-formed JSON object is a final answer in all but prefix.
      if (parseJsonAnswer(text)) {
        return { answer: text.trim(), iterations: i + 1, trace: scratchpad };
      }

      scratchpad.push({
        role: 'user',
        content: 'Error: invalid format. Output exactly one Action (with Action Input) or one Final Answer.',
      });
    }

    return { answer: null, iterations: this.maxIterations, trace: scratchpad };
  }
}
