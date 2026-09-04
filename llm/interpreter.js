import { solverSystem, forModel } from './prompts.js';

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
// Accept the commonly emitted Input: alias to avoid retry loops.
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

      // Accept a bare JSON object as a final answer.
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
