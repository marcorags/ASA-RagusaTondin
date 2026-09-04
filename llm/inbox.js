const DEDUPE_MS = 20000;

export class MissionInbox {
  /**
   * @param {import('../core/world.js').World} world
   * @param {{ onMission: (text:string, senderId:string, senderName:string) => Promise<void>,
   *           onRaw?: (text:string, senderId:string) => void, debug?: boolean }} opts
   */
  constructor(world, opts) {
    this.world = world;
    this.onMission = opts.onMission;
    this.onRaw = opts.onRaw;
    this.debug = opts.debug ?? false;
    /** @type {{text:string, senderId:string, senderName:string}[]} */
    this.queue = [];
    /** @type {Map<string, number>} dedupe: `${senderId}|${text}` → receivedAt */
    this.seen = new Map();
    this._draining = false;
  }

  /** Register the single onMsg listener. Call once after connectWorld. */
  attach() {
    this.world.client.onMsg((/** @type {string} */ id, /** @type {string} */ name, /** @type {any} */ msg, /** @type {any} */ reply) => {
      if (id === this.world.me.id) return;               // own echo (say-to-self pattern exists)
      if (typeof msg !== 'string') return;               // structured object = team channel, not a mission
      if (reply) return;                                 // asks are answered on the fast path, never via LLM
      // RAW hook: fires on EVERY string, BEFORE dedupe — state-change messages
      // (RED/GREEN light) repeat identically and must reach the reflex each time.
      this.onRaw?.(msg, id);
      const key = `${id}|${msg}`;
      const now = Date.now();
      const last = this.seen.get(key) ?? 0;
      if (now - last < DEDUPE_MS) return;                // duplicate shout → zero LLM cost
      this.seen.set(key, now);
      this.queue.push({ text: msg, senderId: id, senderName: name });
      if (this.debug) console.log(`[inbox] queued from ${name}(${id}): ${msg.slice(0, 100)}`);
      void this._drain();
    });
  }

  /** Serialized worker: one interpretation at a time (no shared-state races). */
  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this.queue.length > 0) {
        const item = /** @type {{text:string, senderId:string, senderName:string}} */ (this.queue.shift());
        try {
          await this.onMission(item.text, item.senderId, item.senderName);
        } catch (err) {
          // Loqua's rule: an interpretation failure never breaks the agent.
          console.error('[inbox] mission handling failed:', err instanceof Error ? err.message : err);
        }
      }
    } finally {
      this._draining = false;
    }
  }
}
