import { expect, test } from '@playwright/test';

// Online tests target the deployed staging Worker (STAGING_URL set by CI).
// Without it (local `npm test` / `wrangler dev`), the suite skips cleanly.
const online = Boolean(process.env.STAGING_URL);

test.describe(online ? 'online smoke' : 'smoke (skipped — set STAGING_URL)', () => {
  test.skip(!online, 'STAGING_URL is not set; online E2E runs in CI after staging deploy');

  test('staging Worker is online and healthy', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.service).toBe('mvc-server');
    expect(body.ok).toBe(true);
  });

  test('root auto-redirects to the public install page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/installation$/);
    await expect(page.locator('h1')).toHaveText(/multiplayer vibe code/i);
    await expect(page.getByText('npm link --workspace @mvc/agent')).toBeVisible();
    await expect(page.getByText('/mcp')).toBeVisible();
  });
});