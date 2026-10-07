import { expect, Page, test } from '@playwright/test';
import { signIn, signOut, USERS } from '../helpers/auth';

// Separate browser processes and contexts have independent authentication storage.
// User-confirmed policy for TC-AU-007: both sessions should remain active.
test('TC-AU-007: The same Manager account remains functional in two independent browsers', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const firstContext = await browser.newContext({ baseURL });
  const secondBrowser = await browser.browserType().launch({ headless: true });
  const secondContext = await secondBrowser.newContext({ baseURL });
  firstContext.setDefaultTimeout(15_000);
  secondContext.setDefaultTimeout(15_000);
  const results: object[] = [];

  async function verifyProtectedList(page: Page, session: string, reload = false) {
    // Leave the landing list before listening, so its pending response cannot
    // be mistaken for the fresh protected request triggered below.
    if (!reload) await page.goto('/account');
    const [{ ok, body }] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql')
        && r.request().postDataJSON()?.operationName === 'Requests')
        .then(async response => ({ ok: response.ok(), body: await response.json() })),
      reload ? page.reload() : page.goto('/manager/requests'),
    ]);
    expect(ok, `${session}: protected request-list API must succeed`).toBe(true);
    expect(body.errors, `${session}: no authentication or API errors`).toBeUndefined();
    expect(body.data.requests.items.length).toBeGreaterThan(0);
    await expect(page).toHaveURL(/\/manager\/requests$/);
    await expect(page.getByRole('heading', { name: 'All requests', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    const firstRequest = body.data.requests.items[0].requestNo;
    await expect(page.getByRole('cell', { name: firstRequest, exact: true })).toBeVisible();
    results.push({ session, action: reload ? 'reload' : 'open protected list', authenticated: true,
      returnedRequests: body.data.requests.items.length });
  }

  try {
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    let firstUser: { id: string };
    await test.step('First browser signs in and accesses authenticated Manager data', async () => {
      firstUser = await signIn(first, USERS.manager);
      await verifyProtectedList(first, 'Browser 1');
    });
    await test.step('Second independent browser signs in using the same account', async () => {
      const secondUser = await signIn(second, USERS.manager);
      expect(secondUser.id).toBe(firstUser.id);
      await verifyProtectedList(second, 'Browser 2');
    });
    await test.step('Both sessions fetch protected data concurrently after the second login', async () => {
      await Promise.all([
        verifyProtectedList(first, 'Browser 1', true),
        verifyProtectedList(second, 'Browser 2', true),
      ]);
    });
    await test.step('Both sessions remain functional on subsequent navigation', async () => {
      await Promise.all([first.goto('/account'), second.goto('/account')]);
      await Promise.all([
        expect(first.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(),
        expect(second.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(),
      ]);
      await Promise.all([
        verifyProtectedList(first, 'Browser 1'),
        verifyProtectedList(second, 'Browser 2'),
      ]);
      await test.info().attach('browser-1-still-active', { body: await first.screenshot(), contentType: 'image/png' });
      await test.info().attach('browser-2-still-active', { body: await second.screenshot(), contentType: 'image/png' });
    });
    await test.info().attach('concurrent-login-results', {
      body: JSON.stringify({ account: USERS.manager, independentBrowserProcesses: 2,
        intendedPolicy: 'Both sessions should remain active',
        observedBehavior: 'Both sessions remain authenticated and functional', results }, null, 2),
      contentType: 'application/json',
    });
    console.log(JSON.stringify({ independentBrowserProcesses: 2, bothSessionsActive: true, protectedDataChecks: results.length, result: 'PASSED' }));
    await signOut(first);
    await signOut(second);
  } finally {
    await firstContext.close();
    await secondContext.close();
    await secondBrowser.close();
  }
});

