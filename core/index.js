import { validateCoreConfig, assertCoinsExecution } from './config.js';

// Stage 2 guarded entry: no route has a verified exclusive Coins guarantee.
// Adapter SDK activation, media IO and protocol mappings belong to later gates.
export function createExecutionCore({ config }) {
  const selected = validateCoreConfig(config);
  return Object.freeze({
    config: structuredClone(selected),
    async start({ accountObservation } = {}) {
      assertCoinsExecution(selected, accountObservation);
    },
  });
}
