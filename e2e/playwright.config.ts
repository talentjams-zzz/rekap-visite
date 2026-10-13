import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90_000,
  workers: 1, // one scratch server per worker; keeps ports deterministic
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
});
