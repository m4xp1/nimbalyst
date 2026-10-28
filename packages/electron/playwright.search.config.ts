// Paid API access is off unless this launch explicitly opts in.
process.env.NIMBALYST_ALLOW_OPENAI_API ??= '0';
import { defineConfig } from '@playwright/test';
// This gate deliberately does not load .env or use the Vite dev server.
export default defineConfig({
  testDir: './e2e', testMatch: ['russian-quick-open.spec.ts','memory-session-search.spec.ts','russian-wiki-search.spec.ts','git-stable.spec.ts','git-sync.spec.ts','attached-folder-search.spec.ts'], workers: 1,
  fullyParallel: false, forbidOnly: !!process.env.CI, retries: process.env.CI ? 1 : 0,
  timeout: 60000, outputDir: '../../e2e_test_output/search-results',
  reporter: [['list'], ['html', { outputFolder: '../../e2e_test_output/search-report', open: 'never' }]],
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
