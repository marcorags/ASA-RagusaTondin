import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getScenario } from './scenario-map.js';

const scenarioId = process.argv[2];
if (!scenarioId) {
  console.error('Usage: node mission-launcher.js <scenario-id>');
  process.exit(2);
}

const scenario = getScenario(scenarioId);
const here = dirname(fileURLToPath(import.meta.url));
const missionDir = process.env.MISSION_AGENTS_DIR
  ? resolve(process.env.MISSION_AGENTS_DIR)
  : null;

if (!missionDir || !existsSync(missionDir)) {
  console.error('MISSION_AGENTS_DIR must name the official Deliveroo missionAgents directory.');
  process.exit(2);
}

console.log(JSON.stringify({
  scenario: scenarioId,
  mission_agent: scenario.missionAgent,
  mission_args: scenario.missionArgs,
}));

const child = spawn('node', scenario.missionArgs, {
  cwd: missionDir,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
