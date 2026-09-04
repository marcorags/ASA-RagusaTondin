import { getScenario, scenarioMap } from './scenario-map.js';

const id = process.argv[2];
if (!id || id === '--all') {
  console.log(JSON.stringify(scenarioMap, null, 2));
} else {
  console.log(JSON.stringify(getScenario(id), null, 2));
}
