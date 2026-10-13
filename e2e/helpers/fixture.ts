import { test as base } from '@playwright/test';
import { startScratchServer, type Scratch } from './server.js';

// One scratch server per test: isolated master + DB + port (test-scoped gives
// each test a clean database).
export const test = base.extend<{ server: Scratch }>({
  server: async ({}, use) => {
    const s = await startScratchServer();
    await use(s);
    await s.close();
  },
});

export { expect } from '@playwright/test';
