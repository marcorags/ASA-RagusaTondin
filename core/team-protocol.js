import 'dotenv/config';
import crypto from 'node:crypto';

/**
 * Team protocol A↔B — structured messages over the game chat, hardened
 * against every quirk we verified against the server: `reply` exists only for
 * asks (and may throw after the server's HARD 1s timeout → try/catch);
 * `'timeout'` is a truthy STRING, so `if (reply)` is never enough; recipients
 * are agent IDS, not names; shouts reach everyone (opponents included) and
 * therefore carry no strategy, only the handshake.
 *
 * TRUST MODEL. Sender ids in onMsg are asserted by the SERVER (token-based):
 * other agents cannot spoof them. What an impostor CAN do is answer our
 * handshake pretending to be our teammate. Hence: identity DISCOVERY is
 * protected by an HMAC over a fresh nonce with a SHARED SECRET from .env
 * (never sent on the wire); after pairing, `senderId === teammateId` is
 * sufficient — per-message signing would add nothing, since the server
 * already authenticates the sender id. Recorded here as a deliberate
 * non-choice, not an oversight.
 *
 * HANDSHAKE, three messages, both sides authenticated:
 *
 *   A ──shout── hello(nA) ──────────────────────────────▶ everyone
 *   B ──say──── hello-ack(nA, HMAC(ack|nA|B)) ──────────▶ A     A verifies, pairs
 *   A ──say──── hello-confirm(nA, HMAC(confirm|nA|A)) ──▶ B     B verifies, pairs
 *
 * The nonce travels in the clear — it is a freshness token, not a secret — and
 * both signatures are taken over it, so neither side can be impersonated
 * without the shared secret. B has to remember the nonces it answered
 * (`_acked`), because a confirm can only be checked against a challenge B
 * itself issued an ack for; anything else is replayed or forged and is
 * dropped. Those nonces expire: an opponent shouting hellos must not be able
 * to grow that map without bound.
 *
 * PERFORMATIVES (a FIPA-ACL subset): the `type` field is a speech act —
 * hello/hello-ack/hello-confirm (handshake), claim (propose), directive
 * (request), belief (inform), task (request).
 *
 * CLAIMS = Contract-Net-lite on the standard mission: before committing to a
 * parcel an agent asks the teammate for it, so the two never converge on the
 * same target. The naive version of this scheme has a race — when both ask at
 * the same instant, each can grant the other and both proceed. We close it
 * DETERMINISTICALLY (lower agent id wins), so a double pickup is impossible
 * even under simultaneous requests.
 */

const PROTO_V = 1;
const CLAIM_TTL_MS = 15000;
const HELLO_INTERVAL_MS = 5000;
/** How long a nonce we answered stays valid for closing the handshake. */
const NONCE_TTL_MS = 30000;

export class TeamProtocol {
  /**
   * @param {any} client - DjsClientSocket (emitSay/emitAsk/emitShout/onMsg)
   * @param {{ name?:string, secret?:string, debug?:boolean,
   *   onDirective?: (payload:any) => void,
   *   onBelief?: (payload:any) => void,
   *   onTask?: (payload:any) => void,
   *   onPaired?: (teammateId:string) => void }} [opts]
   */
  constructor(client, opts = {}) {
    this.client = client;
    this.secret = opts.secret ?? process.env.TEAM_SECRET ?? '';
    this.name = opts.name ?? 'agent';
    this.debug = opts.debug ?? false;
    /** @type {string} set by attach() */
    this.meId = '';
    /** @type {string|null} the authenticated teammate id */
    this.teammateId = null;
    this.hooks = opts;
    /** @type {Map<string, {owner:string, at:number}>} parcelId → claim */
    this.claims = new Map();
    this._nonce = crypto.randomUUID();
    /** @type {Map<string, number>} nonces we answered with an ack → when */
    this._acked = new Map();
    /** @type {ReturnType<typeof setInterval>|null} */
    this._helloTimer = null;
  }

  /** @param {...string} parts */
  sig(...parts) {
    return crypto.createHmac('sha256', this.secret).update(parts.join('|')).digest('hex').slice(0, 16);
  }

  /** @param {any} m */
  isTeamMsg(m) {
    return !!m && typeof m === 'object' && m.v === PROTO_V && typeof m.type === 'string';
  }

  /** Register the listener and start announcing until paired. */
  attach(/** @type {string} */ meId) {
    this.meId = meId;
    this.client.onMsg((/** @type {string} */ id, /** @type {string} */ _name, /** @type {any} */ msg, /** @type {any} */ reply) =>
      this._onMsg(id, msg, reply));
    if (!this.secret) { console.warn('[team] TEAM_SECRET not set → solo mode (no pairing)'); return; }
    const hello = () => { if (!this.teammateId) void this.client.emitShout({ v: PROTO_V, type: 'hello', from: this.meId, nonce: this._nonce }); };
    this._helloTimer = setInterval(hello, HELLO_INTERVAL_MS);
    hello();
  }

  /** @param {string} id @param {any} msg @param {any} reply */
  async _onMsg(id, msg, reply) {
    if (id === this.meId || !this.isTeamMsg(msg) || !this.secret) return;

    // --- Handshake ----------------------------------------------------------
    if (msg.type === 'hello' && typeof msg.nonce === 'string') {
      // Answer any hello: only the true teammate can VERIFY our ack anyway.
      // The nonce is kept so the confirm that closes the handshake can be
      // checked against a challenge we actually answered.
      this._rememberAcked(msg.nonce);
      void this.client.emitSay(id, { v: PROTO_V, type: 'hello-ack', from: this.meId, nonce: msg.nonce, sig: this.sig('ack', msg.nonce, this.meId) });
      return;
    }
    if (msg.type === 'hello-ack' && msg.nonce === this._nonce) {
      if (msg.sig !== this.sig('ack', this._nonce, id)) {
        console.log(`[team] REJECTED hello-ack from ${id}: invalid signature (impostor or wrong secret)`);
        return;
      }
      this._pair(id);
      void this.client.emitSay(id, { v: PROTO_V, type: 'hello-confirm', from: this.meId, nonce: this._nonce, sig: this.sig('confirm', this._nonce, this.meId) });
      return;
    }
    if (msg.type === 'hello-confirm' && typeof msg.nonce === 'string') {
      // Closing message: it pairs THIS side. The signature is over the
      // initiator's nonce, which we know because we are the one who acked it —
      // a confirm quoting any other nonce was never challenged by us.
      if (this.teammateId === id) return;                       // already paired
      if (!this._acked.has(msg.nonce)) return;                  // not a handshake of ours
      if (msg.sig !== this.sig('confirm', msg.nonce, id)) {
        console.log(`[team] REJECTED hello-confirm from ${id}: invalid signature (impostor or wrong secret)`);
        return;
      }
      this._acked.delete(msg.nonce);                            // single use
      this._pair(id);
      return;
    }

    // --- Authenticated channel: everything below requires the paired id ----
    // (claims included: an unauthenticated "claim" could reserve parcels and
    // starve us — an opponent-controlled denial. Before pairing completes the
    // asker just times out and proceeds solo: safe > available, briefly.)
    if (this.teammateId !== id) return;

    if (msg.type === 'claim' && typeof msg.parcelId === 'string' && reply) {
      // Random jitter breaks the symmetry, well within the server's 1s budget.
      await new Promise((r) => setTimeout(r, Math.random() * 30));
      const granted = this._grantClaim(msg.parcelId, id);
      try { reply(granted); } catch (error) { if (this.debug) console.error('[team] reply failed:', error); }
      return;
    }

    if (msg.type === 'directive' && this.hooks.onDirective) { this.hooks.onDirective(msg.payload); return; }
    if (msg.type === 'belief' && this.hooks.onBelief) { this.hooks.onBelief(msg.payload); return; }
    if (msg.type === 'task' && this.hooks.onTask) { this.hooks.onTask(msg.payload); return; }
  }

  /**
   * Remember a nonce we answered, and drop the ones that have expired. The
   * sweep runs here rather than on a timer: the map only grows when a hello
   * arrives, so that is exactly when it is worth trimming.
   * @param {string} nonce
   */
  _rememberAcked(nonce) {
    const now = Date.now();
    for (const [n, at] of this._acked) if (now - at > NONCE_TTL_MS) this._acked.delete(n);
    this._acked.set(nonce, now);
  }

  /** @param {string} id */
  _pair(id) {
    if (this.teammateId === id) return;
    this.teammateId = id;
    if (this._helloTimer) { clearInterval(this._helloTimer); this._helloTimer = null; }
    console.log(`[team] paired with teammate ${id} (authenticated)`);
    this.hooks.onPaired?.(id);
  }

  /**
   * Decide a claim request from `requester`. Deterministic tie-break: when
   * BOTH hold an optimistic claim on the same parcel, the LOWER id wins —
   * this is what closes the simultaneous-request race described above.
   * @param {string} parcelId @param {string} requester
   */
  _grantClaim(parcelId, requester) {
    const now = Date.now();
    const cur = this.claims.get(parcelId);
    const mine = cur && cur.owner === this.meId && now - cur.at < CLAIM_TTL_MS;
    if (mine && !(requester < this.meId)) return false;
    this.claims.set(parcelId, { owner: requester, at: now });
    return true;
  }

  /**
   * Ask the teammate for a claim on a parcel before committing to it.
   * Resolves true when we may take it. No teammate / silent teammate ⇒ true
   * (solo fallback, the agent never blocks on coordination). Explicit
   * `=== true` per the verified `'timeout'`-is-truthy gotcha.
   * @param {string} parcelId
   */
  async requestClaim(parcelId) {
    if (!this.teammateId) return true;
    const now = Date.now();
    const cur = this.claims.get(parcelId);
    if (cur && cur.owner === this.teammateId && now - cur.at < CLAIM_TTL_MS) return false;
    this.claims.set(parcelId, { owner: this.meId, at: now }); // optimistic
    const resp = await this.client.emitAsk(this.teammateId, { v: PROTO_V, type: 'claim', from: this.meId, parcelId });
    if (resp === true) return true;
    if (resp === false) { this.claims.set(parcelId, { owner: this.teammateId, at: now }); return false; }
    return true; // 'timeout' | null | garbage → proceed solo (documented)
  }

  /** Forward compiled directives to the teammate (B coordinates, A adapts). */
  sendDirective(/** @type {any} */ payload) {
    if (this.teammateId) void this.client.emitSay(this.teammateId, { v: PROTO_V, type: 'directive', from: this.meId, payload });
  }

  /** Share beliefs: e.g. parcels the teammate cannot see from where it is. */
  sendBelief(/** @type {any} */ payload) {
    if (this.teammateId) void this.client.emitSay(this.teammateId, { v: PROTO_V, type: 'belief', from: this.meId, payload });
  }

  /** Assign an explicit task to the teammate (L3 missions: meet_at, handoff roles). */
  sendTask(/** @type {any} */ payload) {
    if (this.teammateId) void this.client.emitSay(this.teammateId, { v: PROTO_V, type: 'task', from: this.meId, payload });
  }
}
