import 'dotenv/config';
import OpenAI from 'openai';

/**
 * LLM provider client — the ONLY module in the system that talks to an LLM
 * API. Provider-abstract by design: any OpenAI-compatible endpoint works, and
 * switching provider means editing three lines of `.env`, never code:
 *
 *   LLM_BASE_URL  any OpenAI-compatible endpoint
 *   LLM_API_KEY   provider key (never committed)
 *   LLM_MODEL     model identifier as the provider names it
 *
 * The default model is the one that WON the measured comparison of the
 * mission suite, not the largest available: on these missions a 30B model
 * scores as well as a 70B one and answers roughly nine times faster, which in
 * a real-time game is the difference between a usable head and an unusable
 * one. Bigger is a cost here, not a feature.
 *
 * Design constraints it enforces, all of them consequences of the fact that
 * inference takes real time while the game clock keeps running:
 *  - hard TIMEOUT per call (the game clock must never wait on us);
 *  - bounded retries (the OpenAI SDK retries transient failures natively);
 *  - defensive response reading (`choices?.[0]?.message?.content ?? ''`:
 *    a well-formed HTTP 200 can still carry an empty completion);
 *  - TOKEN ACCOUNTING per call and cumulative, because prompt design choices
 *    are only comparable if their cost is measured.
 */
export class LlmClient {
  /**
   * @param {{ baseURL?:string, apiKey?:string, model?:string, timeoutMs?:number, maxRetries?:number }} [opts]
   */
  constructor(opts = {}) {
    this.baseURL = opts.baseURL ?? process.env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1';
    this.model = opts.model ?? process.env.LLM_MODEL ?? 'qwen/qwen3-30b-a3b';
    const apiKey = opts.apiKey ?? process.env.LLM_API_KEY;
    if (!apiKey) throw new Error('LLM_API_KEY is not set (see .env.example)');
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 30000);
    this._client = new OpenAI({
      baseURL: this.baseURL,
      apiKey,
      timeout: this.timeoutMs,
      maxRetries: opts.maxRetries ?? 2,
    });
    /** Cumulative token usage across all calls (report metric). */
    this.usage = { prompt: 0, completion: 0, calls: 0 };
  }

  /**
   * One chat completion. Returns the assistant text ('' on empty response).
   * Throws on timeout/error after the SDK's bounded retries: the CALLER
   * decides the fallback (Loqua's rule: on LLM failure, ignore the mission
   * and keep playing — the agent never breaks).
   * @param {{role:'system'|'user'|'assistant', content:string}[]} messages
   * @param {{ temperature?:number }} [opts]
   * @returns {Promise<string>}
   */
  async chat(messages, opts = {}) {
    const response = await this._client.chat.completions.create({
      model: this.model,
      messages,
      temperature: opts.temperature ?? 0, // deterministic by default: an agent loop wants reproducible decisions
    });
    this.usage.calls += 1;
    this.usage.prompt += response.usage?.prompt_tokens ?? 0;
    this.usage.completion += response.usage?.completion_tokens ?? 0;
    return response.choices?.[0]?.message?.content ?? '';
  }
}
