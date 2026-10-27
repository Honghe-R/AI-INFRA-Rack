// Synthetic, offline batch demonstration; no plan is saved or changed.
import { checkRackLayout } from '@ai-infra/rack';
import { createLayoutScenarios } from './layout-scenarios.mjs';

console.log(JSON.stringify({
  synthetic: true,
  results: createLayoutScenarios().map(([name, input]) => ({ name, ...checkRackLayout(input) })),
}, null, 2));
