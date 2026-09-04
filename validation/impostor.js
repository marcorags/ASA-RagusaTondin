import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';
import { TeamProtocol } from '../core/team-protocol.js';

/**
 * VALIDATION — an IMPOSTOR. Joins the game and runs the team protocol with a
 * WRONG shared secret, answering the real team's handshake hellos with invalid
 * signatures.
 *
 * Expected outcome in the real agents' logs:
 *   "[team] REJECTED hello-ack … invalid signature"
 *
 * This is the adversarial half of the team protocol's security claim: the unit
 * tests show that a correct pairing succeeds, this shows that an incorrect one
 * is refused by a live agent in a live game. Pairing is gated by the secret,
 * not by good faith.
 *
 * Usage: node validation/impostor.js
 */
const client = DjsConnect(process.env.HOST, undefined, 'Impostor');
/** @type {{id:string}} */
const me = { id: '' };
client.onYou((a) => {
  if (!me.id) {
    me.id = a.id;
    const p = new TeamProtocol(client, { name: 'Impostor', secret: 'totally-wrong-secret' });
    p.attach(me.id);
    console.log(`[impostor] up as ${me.id}, spoofing handshake with a wrong secret...`);
  }
});
