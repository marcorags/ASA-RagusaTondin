/**
 * Tool registry — the catalog of things the LLM can actually DO.
 *
 * Uniform contract: every tool takes ONE string argument ('none' when absent)
 * and returns a string, because observations are text fed back to the model.
 * Registry keys are the names the model writes after `Action:`; unknown names
 * are handled by the interpreter, which answers with an error observation
 * listing the catalog so the model can correct itself.
 *
 * Inputs are VALIDATED in code before execution. Function calling gets a tool
 * NAME right far more reliably than it gets ARGUMENTS right, and parameter
 * hallucination is precisely the failure the calling protocol does not solve
 * for you — so the validation has to live on this side of the boundary.
 *
 * The game-facing tools are INJECTED through `deps` rather than imported: in
 * the tests they are mocks, at runtime they close over the live world and
 * belief store. That keeps the registry and the interpreter fully testable
 * with no game server in the loop.
 *
 * The catalog is GENERATED from the registry, so the tool list the model sees
 * can never drift from the tools it can actually call.
 */

/**
 * Safe arithmetic evaluation. The obvious implementation — hand the string to
 * `eval` — executes arbitrary attacker-chosen code, and the string comes from
 * a chat message an opponent can write. So: accept only a numeric-expression
 * CHARSET first (no letters means no identifiers, therefore no calls, no
 * property access, no assignment), then evaluate inside an argument-less
 * Function rather than in the enclosing scope.
 * @param {string} input
 * @returns {string}
 */
export function calculate(input) {
  const expr = String(input ?? '').trim();
  // Misleading feedback trap (measured): if the model forgot the input line,
  // a generic charset error makes it "fix" the expression instead of the
  // FORMAT. Say precisely what is missing and how to provide it.
  if (expr.length === 0 || expr === 'none') {
    return "Error: no expression provided. Provide it on its own line as: Action Input: <expression>";
  }
  if (expr.length > 200) return 'Error: expression too long.';
  if (!/^[\d\s+\-*/().,%]+$/.test(expr)) {
    return `Error: invalid expression "${expr.slice(0, 60)}" — only numbers and + - * / ( ) . % are allowed.`;
  }
  try {
    const value = Function(`"use strict"; return (${expr});`)();
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Error: not a finite number.';
    return String(value);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : 'invalid expression'}`;
  }
}

/**
 * Build the registry + the prompt catalog from injected game bindings.
 * Only `calculate` is always available; the rest appear when provided,
 * so the catalog the model sees always matches what it can call.
 *
 * @param {{
 *   getState?: () => string,
 * }} [deps]
 * @returns {{ registry: Record<string, (input:string) => string|Promise<string>>, catalog: string }}
 */
export function createTools(deps = {}) {
  /** @type {Record<string, (input:string) => string|Promise<string>>} */
  const registry = { calculate };
  const lines = [
    '- calculate: evaluate an arithmetic expression. Action Input: the expression, e.g. (5*(5+3)/2)+2',
  ];

  if (deps.getState) {
    registry.get_state = () => /** @type {() => string} */ (deps.getState)();
    lines.push('- get_state: current agent state as JSON (position, score, carrying, visible parcels, delivery tiles, map size). Action Input: none');
  }

  return { registry, catalog: lines.join('\n') };
}
