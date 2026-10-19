import { expect, Page, test } from '@playwright/test';
import { waitForGraphqlResponse } from '../helpers/graphql';
import { signIn, signOut } from '../helpers/auth';

// Existing synthetic Hospital B request, also used by TC-HP-012.
const REQUEST_NO = 'REQ-2026-0673';
const REQUEST_PATH = `/partner/requests/${REQUEST_NO}`;

async function expectLoggedOut(page: Page, caseDescription: string) {
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByRole('textbox', { name: 'ID or email*', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: REQUEST_NO, exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(caseDescription);
}

for (const method of ['browser Back', 'reused request URL']) {
  test(`TC-AU-004: Logout prevents access through ${method}`, async ({ page, context }) => {
    test.setTimeout(60_000);
    page.setDefaultTimeout(15_000);

    // 1. Sign in and confirm the request details are visible.
    await signIn(page, 'hospital.b@saerosoft.com');
    const [response] = await Promise.all([
      waitForGraphqlResponse(page, 'Request'),
      page.goto(REQUEST_PATH),
    ]);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    expect(body.data.request.details).toMatchObject({
      requestNo: REQUEST_NO,
      hospital: 'Hospital B Medical Center',
    });
    const caseDescription = body.data.request.details.caseDescription;
    expect(typeof caseDescription).toBe('string');
    expect(caseDescription.trim().length).toBeGreaterThan(0);
    const requestQuery = response.request().postDataJSON();
    const graphqlUrl = response.url();
    await expect(page.getByRole('heading', { name: REQUEST_NO, exact: true })).toBeVisible();
    await expect(page.getByText(caseDescription).first()).toBeVisible();

    // 2. Sign out.
    // Keep the request in history even if logout replaces the current entry.
    if (method === 'browser Back') {
      await page.goto('/account');
    }
    await signOut(page);
    await expectLoggedOut(page, caseDescription);

    // 3. Try opening the protected request again, then refresh the page.
    if (method === 'browser Back') {
      await page.goBack();
      await expectLoggedOut(page, caseDescription);
      // Also cover an app which pushes login instead of replacing history.
      await page.goBack();
    } else {
      await page.goto(REQUEST_PATH);
    }
    await expectLoggedOut(page, caseDescription);
    await page.reload();
    await expectLoggedOut(page, caseDescription);
    await test.info().attach('logged-out-access-blocked', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // 4. Check that the API also rejects the logged-out session.
    // Use the post-logout cookie jar, without copying old authentication headers.
    const loggedOutResponse = await context.request.post(graphqlUrl, { data: requestQuery });
    const status = loggedOutResponse.status();
    if (status === 200) {
      const body = await loggedOutResponse.json();
      expect(body.data?.request).toBeFalsy();
      expect(body.errors?.length).toBeGreaterThan(0);
      let accessDenied = false;
      for (const error of body.errors) {
        const message = error.message;
        const classification = error.extensions?.classification;
        const code = error.extensions?.code;
        const errorText = [message, classification, code].join(' ');
        if (/unauthenticated|unauthorized|forbidden|access.denied/i.test(errorText)) {
          accessDenied = true;
        }
      }
      expect(accessDenied).toBe(true);
    } else {
      expect([401, 403]).toContain(status);
    }
    const result = {
      method,
      request: REQUEST_NO,
      redirectedToLogin: true,
      requestDetailsAbsent: true,
      protectedApiDenied: true,
      apiStatus: status,
    };
    await test.info().attach('logout-result', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    console.log(JSON.stringify(result));
  });
}
