import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  reporter: [['list']],
  // Online tests target the deployed staging Worker — see CI workflow.
  use: {
    baseURL: process.env.STAGING_URL || 'http://127.0.0.1:8787',
  },
});