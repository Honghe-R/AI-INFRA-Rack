// Offline demonstration; no server, database or user design is modified.
import { readFile } from 'node:fs/promises';
import { checkRackPlacement } from '@ai-infra/rack';

const room = JSON.parse(await readFile(new URL('./rectangular-room.json', import.meta.url), 'utf8'));
const { model, placement } = JSON.parse(await readFile(new URL('./basic-rack.json', import.meta.url), 'utf8'));
const cases = [
  ['clear_known_scope', room, placement],
  ['outside_room', room, { ...placement, xM: 0 }],
  ['obstacle_conflict', room, { ...placement, xM: 4.5 }],
  ['unknown_obstacles', { ...room, obstacleCoverage: 'UNKNOWN', obstacles: [] }, placement],
];

console.log(JSON.stringify({
  synthetic: true,
  results: cases.map(([name, roomInput, placementInput]) => {
    const report = checkRackPlacement(roomInput, model, placementInput);
    return { name, ...report };
  }),
}, null, 2));
