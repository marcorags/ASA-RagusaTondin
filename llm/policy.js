/**
 * Convenience Policy — the assignment's "decide when it is convenient to
 * complete a special mission and when it is better to ignore it", implemented
 * as BDI desire FILTERING under expected utility. Adopting a mission is not a
 * free action: it suspends the standard play that is already earning points,
 * so the decision is a comparison, not a fixed threshold:
 *
 *   adopt(mission) ⇔ E[gain] > opportunityCost(mission) × margin
 *
 * The opportunity cost is what the STANDARD mission would have earned during
 * the mission's duration, priced with the agent's own MEASURED earning rate
 * (pts/s since start). Self-calibrating by design: map richness moves this
 * rate by an ORDER OF MAGNITUDE — a dense spawner cluster yields thousands
 * of points per minute, a sparse map a small fraction of that — so any
 * hard-coded threshold would be badly wrong on some map. The agent measures
 * its own opportunity cost instead of assuming one.
 */
export class ConveniencePolicy {
  /** @param {import('../bdi/strategy.js').Params} params */
  constructor(params) {
    this.p = params;
    this._t0 = Date.now();
    /** @type {number|null} */
    this._score0 = null;
    this._score = 0;
  }

  /** Feed the current score (call once per control-loop tick). */
  noteScore(/** @type {number} */ score) {
    if (this._score0 === null) this._score0 = score;
    this._score = score;
  }

  /**
   * Long-run average earning rate of standard play (pts/s). Until 20s of
   * evidence exists, a prudent default of 1 pt/s applies (floor 0.1: a rate
   * of zero would make ANY positive mission look free).
   */
  earningRate() {
    const dt = (Date.now() - this._t0) / 1000;
    if (this._score0 === null || dt < 20) return 1;
    return Math.max(0.1, (this._score - this._score0) / dt);
  }

  /**
   * Expected-utility verdict for an atomic mission goal.
   * Duration model: walk there and back to useful play (×2 path) plus a
   * fixed 2s overhead (settle beat + pickup detour slack). `gain` for an
   * unknown reward is a prudent 0 — in dubio, keep farming. The ×1.2 margin
   * plays the same hysteresis role as Cassandra's reconsideration δ.
   * @param {number|null} rewardHint
   * @param {number} pathSteps
   */
  evaluate(rewardHint, pathSteps) {
    const rate = this.earningRate();
    const seconds = (pathSteps * this.p.moveMs * 2) / 1000 + 2;
    const cost = rate * seconds;
    const gain = rewardHint ?? 0;
    return {
      adopt: gain > cost * 1.2,
      gain,
      cost: Math.round(cost * 10) / 10,
      rate: Math.round(rate * 100) / 100,
      seconds: Math.round(seconds),
    };
  }
}
