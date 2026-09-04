const redLightPrompt = 'All agents prepare to stop at red light and wait for the green light message before moving again, as in a \u00e2\u20ac\u0153red light, green light\u00e2\u20ac\u009d game. For every movement you will receive a penalty.';

export const scenarioMap = {
  '26c2_1': {
    level: 'L1',
    requirement: 'goto',
    agents: ['Loqua'],
    missionAgent: 'GoTo.js',
    missionArgs: ['GoTo.js', '--prompt', 'Go to one of these coordinates to receive a bonus of 1000pti una tantum.', '--unatantum', 'true', '--bonus', '1000', '--coordinates', '[{"x":19,"y":19},{"x":20,"y":19},{"x":21,"y":19}]'],
  },
  '26c2_2': {
    level: 'L1',
    requirement: 'drop_at',
    agents: ['Loqua'],
    missionAgent: 'DeliverAt.js',
    missionArgs: ['DeliverAt.js', '--prompt', 'Deliver a package in 1,1 to get a 1000pts bonus una tantum.', '--unatantum', 'true', '--bonus', '1000', '--coordinates', '[{"x":1,"y":1}]'],
  },
  '26c2_3': {
    level: 'L1',
    requirement: 'answer',
    agents: ['Loqua'],
    missionAgent: 'QuestionAnswer.js',
    missionArgs: ['QuestionAnswer.js', '--prompt', 'Calculate (5*(5+3)/2)+2 to get a bonus una tantum.', '--bonus', '10000', '--answers', '22'],
  },
  '26c2_4': {
    level: 'L2',
    requirement: 'avoid penalty tiles',
    agents: ['Loqua'],
    missionAgent: 'GoTo.js',
    missionArgs: ['GoTo.js', '--prompt', 'Do not go through tiles (13,15) (14,15) (15,15) (16,15) or you will be penalized.', '--unatantum', 'false', '--bonus', '-1000', '--coordinates', '[{"x":13,"y":15},{"x":14,"y":15},{"x":15,"y":15},{"x":16,"y":15}]'],
  },
  '26c2_5': {
    level: 'L2',
    requirement: 'exactly N parcels',
    agents: ['Loqua'],
    missionAgent: 'deliverExactlyNParcels.js',
    missionArgs: ['deliverExactlyNParcels.js', '--prompt', 'Deliver exactly three packages at a time.', '--bonus', '100', '--parcels', '3'],
  },
  '26c2_6': {
    level: 'L2',
    requirement: 'avoid specified delivery tiles',
    agents: ['Loqua'],
    missionAgent: 'DeliverAt.js',
    missionArgs: ['DeliverAt.js', '--prompt', 'Do never deliver in (15,32) (16,32) (15,31) (16,31).', '--unatantum', 'false', '--bonus', '-500', '--coordinates', '[{"x":15,"y":32},{"x":16,"y":32},{"x":15,"y":31},{"x":16,"y":31}]'],
  },
  '26c2_7': {
    level: 'L2',
    requirement: 'delivery value cap',
    agents: ['Loqua'],
    missionAgent: 'DeliverLessValueThan.js',
    missionArgs: ['DeliverLessValueThan.js', '--prompt', 'Every time you deliver parcels for a total amount of reward lower or equal to 10, you get a bonus.', '--bonus', '1000', '--threshold', '10'],
  },
  '26c2_8': {
    level: 'L3',
    requirement: 'one pickup / another deliver',
    agents: ['Loqua', 'Cassandra_T'],
    missionAgent: 'OnePickupAnotherDeliver.js',
    missionArgs: ['OnePickupAnotherDeliver.js', '--prompt', 'If you pick up a parcel and another agent delivers it, you both receive a bonus.', '--bonus', '500'],
  },
  '26c2_9': {
    level: 'L3',
    requirement: 'red-light / green-light',
    agents: ['Loqua', 'Cassandra_T'],
    missionAgent: 'RedLightGreenLight.js',
    missionArgs: ['RedLightGreenLight.js', '--prompt', redLightPrompt, '--bonus', '-10'],
  },
};

export function getScenario(id) {
  const scenario = scenarioMap[id];
  if (!scenario) throw new Error(`Unknown or excluded Challenge 2 scenario: ${id}`);
  return scenario;
}
