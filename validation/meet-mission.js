import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk/client';

/**
 * VALIDATION — a rendezvous mission agent, written by us.
 *
 * The provided mission agents cover most of the challenge scenarios, but not
 * the two-agent rendezvous, so validating that behaviour required building the
 * counterpart ourselves. It follows the same pattern as the official ones: an
 * admin socket that observes the whole map, shouts the mission prompt, and
 * awards the bonus through the game's own reward channel.
 *
 * It rewards BOTH team agents, once, when they are simultaneously within
 * `maxDistance` (Manhattan) of the target point — which is the property the
 * rendezvous mission actually asks for, and the one an agent that merely walks
 * near the point would fail.
 *
 * Usage: node validation/meet-mission.js <ADMIN_TOKEN> [x y maxDist bonus]
 */
const token = process.argv[2];
const X = Number(process.argv[3] ?? 19);
const Y = Number(process.argv[4] ?? 5);
const R = Number(process.argv[5] ?? 3);
const BONUS = Number(process.argv[6] ?? 500);
const NAMES = ['Loqua', 'Cassandra_T'];
const PROMPT = `Move both agents to the neighborhood of position (${X},${Y}) within a maximum distance of ${R}, and have them wait for each other. You will receive ${BONUS}pts.`;

const client = DjsConnect(process.env.HOST, token);
let rewarded = false;

client.onSensing((/** @type {any} */ s) => {
  if (rewarded) return;
  const near = NAMES.map((n) => s.agents.find((/** @type {any} */ a) => a.name === n))
    .filter((a) => a && Math.abs(Math.round(a.x) - X) + Math.abs(Math.round(a.y) - Y) <= R);
  if (near.length === NAMES.length) {
    rewarded = true;
    for (const a of near) {
      client.emit('reward', { agentId: a.id, points: BONUS });
      console.log(`Rewarded ${a.name} with ${BONUS}pts because: both agents met at (${X},${Y})±${R}`);
    }
  }
});

setTimeout(() => { console.log(PROMPT); void client.emitShout(PROMPT); }, 2000);
