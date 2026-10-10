import { defineConfig } from '@playwright/test';
import path from 'node:path';
// This gate deliberately does not load .env or use the Vite dev server.
export default defineConfig({
  testDir: './e2e', testMatch: 'russian-quick-open.spec.ts', workers: 1,
  fullyParallel: false, forbidOnly: !!process.env.CI, retries: process.env.CI ? 1 : 0,
  timeout: 60000, outputDir: '../../e2e_test_output/search-results',
  reporter: [['list'], ['html', { outputFolder: '../../e2e_test_output/search-report', open: 'never' }]],
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
