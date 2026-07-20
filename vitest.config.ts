import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (which sets root: 'client' for the app build) so that
// vitest can discover tests under both server/ and client/src/ without touching the
// client build config.
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts', 'client/src/**/*.test.ts'],
  },
});
