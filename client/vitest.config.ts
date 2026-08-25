import { defineConfig } from 'vitest/config';

// One runner for the whole client workspace. `packages/*` have their own
// `test` scripts but no runner of their own; including them here means a
// single `npm test` covers every wire-format guardrail in the repo.
export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'packages/*/src/**/__tests__/**/*.test.ts',
    ],
    environment: 'node',
    // Node ESM + our `.js` import specifiers on `.ts` sources.
    // vitest resolves these through its own transform pipeline.
  },
});
