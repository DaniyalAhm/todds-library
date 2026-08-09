import { test, expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

const FRONTEND_URL = process.env.E2E_BASE_URL || 'http://localhost:3330';
const BACKEND_URL = process.env.E2E_API_URL || 'http://localhost:8830/api';
const E2E_USERNAME = process.env.E2E_USERNAME || 'e2eadmin';
const E2E_PASSWORD = process.env.E2E_PASSWORD || 'e2e-password';

test('session survives a full browser restart without re-entering credentials', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);

  await ensureUser(request, E2E_USERNAME, E2E_PASSWORD);

  const context = await browser.newContext();
  const page = await context.newPage();

  await login(page, E2E_USERNAME, E2E_PASSWORD);

  const sessionCookie = (await context.cookies(FRONTEND_URL)).find((cookie) =>
    cookie.name.endsWith('next-auth.session-token')
  );
  expect(sessionCookie, 'expected a persistent next-auth session cookie').toBeTruthy();
  expect(sessionCookie!.expires).toBeGreaterThan(Date.now() / 1000);

  const storageState = await context.storageState();
  await context.close();

  // Simulate a browser restart: a brand-new context that only carries over the
  // persisted cookies (what browsers restore after closing/reopening).
  const restoredContext = await browser.newContext({ storageState });
  const restoredPage = await restoredContext.newPage();

  await restoredPage.goto(`${FRONTEND_URL}/dashboard`);
  await expect(restoredPage).toHaveURL(/\/dashboard$/);
  await expect(restoredPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  await restoredContext.close();
});

async function ensureUser(request: APIRequestContext, username: string, password: string) {
  const loginResponse = await request.post(`${BACKEND_URL}/auth/login`, {
    data: { username, password },
  });
  if (loginResponse.status() === 200) return;

  const setupResponse = await request.get(`${BACKEND_URL}/auth/setup/status`);
  const { needs_setup } = await setupResponse.json();
  if (needs_setup) {
    const registerResponse = await request.post(`${BACKEND_URL}/auth/register`, {
      data: { username, password },
    });
    expect(registerResponse.status()).toBe(200);
    return;
  }

  throw new Error('E2E user does not exist and server setup is already complete.');
}

async function login(page: Page, username: string, password: string) {
  await page.goto(`${FRONTEND_URL}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}
