import { expect, Page, test } from '@playwright/test';
import { signIn, signOut } from '../helpers/auth';

// Existing synthetic Hospital B request, also used by TC-HP-012.
const REQUEST_NO = 'REQ-2026-0673';
const REQUEST_PATH = `/partner/requests/${REQUEST_NO}`;

async function expectLoggedOut(page: Page, patientCode: string) {
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByRole('textbox', { name: 'Email or login ID*', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in ->', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: REQUEST_NO, exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(patientCode);
}

for (const method of ['browser Back', 'reused request URL'] as const) {
  test(`TC-AU-004: Logout prevents access through ${method}`, async ({ page, context }) => {
    test.setTimeout(60_000);
    page.setDefaultTimeout(15_000);
    let patientCode: string;
    let requestQuery: object;
    let graphqlUrl: string;

    await test.step('Sign in and verify access to the protected request', async () => {
      await signIn(page, 'hospital.b@saerosoft.com');
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql')
          && r.request().postDataJSON()?.operationName === 'Request'),
        page.goto(REQUEST_PATH),
      ]);
      const body = await response.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.request.details).toMatchObject({ requestNo: REQUEST_NO, hospital: 'Hospital B Medical Center' });
      patientCode = body.data.request.details.patientCode;
      expect(patientCode).toBeTruthy();
      requestQuery = response.request().postDataJSON();
      graphqlUrl = response.url();
      await expect(page.getByRole('heading', { name: REQUEST_NO, exact: true })).toBeVisible();
      await expect(page.getByText(patientCode).first()).toBeVisible();
    });

    await test.step('Log out of the authenticated browser session', async () => {
      // Keep the request in history even if logout replaces the current entry.
      if (method === 'browser Back') await page.goto('/account');
      await signOut(page);
      await expectLoggedOut(page, patientCode);
    });

    await test.step(`${method} redirects to login without displaying request details`, async () => {
      if (method === 'browser Back') {
        await page.goBack();
        await expectLoggedOut(page, patientCode);
        // Also cover an app which pushes login instead of replacing history.
        await page.goBack();
      } else {
        await page.goto(REQUEST_PATH);
      }
      await expectLoggedOut(page, patientCode);
      await page.reload();
      await expectLoggedOut(page, patientCode);
      await test.info().attach('logged-out-access-blocked', { body: await page.screenshot(), contentType: 'image/png' });
    });

    await test.step('Protected request API rejects the browser context after logout', async () => {
      // Use the post-logout cookie jar, without copying old authentication headers.
      const response = await context.request.post(graphqlUrl, { data: requestQuery });
      const status = response.status();
      if (status === 200) {
        const body = await response.json();
        expect(body.data?.request).toBeFalsy();
        expect(body.errors?.length).toBeGreaterThan(0);
        expect(body.errors.some((error: any) => /unauthenticated|unauthorized|forbidden|access.denied/i.test(
          `${error.message} ${error.extensions?.classification} ${error.extensions?.code}`
        ))).toBe(true);
      } else {
        expect([401, 403]).toContain(status);
      }
      const result = { method, request: REQUEST_NO, redirectedToLogin: true,
        requestDetailsAbsent: true, protectedApiDenied: true, apiStatus: status };
      await test.info().attach('logout-result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
      console.log(JSON.stringify(result));
    });
  });
}
