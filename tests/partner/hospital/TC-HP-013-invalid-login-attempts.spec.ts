import { expect, test } from '@playwright/test';
import { LOGIN_URL, PASSWORD, selectEnglish } from '../../helpers/auth';

// Use Hospital C to avoid disrupting accounts used by the review workflow.
const ACCOUNT = 'hospital.c@saerosoft.com';

test('TC-HP-013: Repeated incorrect passwords show safe errors and correct login or rate-limit behavior', async ({ page }) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(15_000);
  await page.goto(LOGIN_URL);
  await selectEnglish(page);
  await page.getByRole('textbox', { name: 'Email or login ID*' }).fill(ACCOUNT);
  const password = page.getByRole('textbox', { name: /^Password\*/ });
  const attempts: object[] = [];
  let invalidCredentialErrors = 0;
  let firstAttemptWasLimited = false;

  for (let attempt = 1; attempt <= 5; attempt++) {
    await test.step(`Incorrect password attempt ${attempt} is rejected with a clear error`, async () => {
      await password.fill('UAT-deliberately-incorrect-password');
      const [body] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql')
          && r.request().postDataJSON()?.operationName === 'Login').then(r => r.json()),
        page.getByRole('button', { name: 'Sign in ->', exact: true }).click(),
      ]);
      expect(body.errors?.length).toBeGreaterThan(0);
      expect(body.data?.login).toBeFalsy();
      const error = body.errors[0];
      const rateLimited = error.extensions?.code === 'RATE_LIMITED';
      if (attempt === 1) firstAttemptWasLimited = rateLimited;
      if (!rateLimited) invalidCredentialErrors++;
      expect(error.message).toMatch(/invalid|incorrect|credential|password|too many requests|try again later|authentication failed/i);
      await expect(page.getByText(error.message, { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
      await expect(password).toHaveAttribute('type', 'password');
      const visibleText = await page.locator('body').innerText();
      expect(visibleText).not.toMatch(/stack trace|SQLException|java\.[\w.]+|org\.springframework|Traceback|SQLSTATE|password hash|Exception:/i);
      expect(visibleText).not.toContain('UAT-deliberately-incorrect-password');
      expect(error.message).not.toContain(PASSWORD);
      attempts.push({ attempt, message: error.message, rateLimited,
        retryAfterSeconds: error.extensions?.retryAfterSeconds });
    });
  }
  // An already limited account cannot establish wrong-password rejection.
  expect(firstAttemptWasLimited, 'The first attempt must test credentials, not a pre-existing cooldown').toBe(false);
  expect(invalidCredentialErrors).toBeGreaterThan(0);
  await test.info().attach('incorrect-login-error', { body: await page.screenshot(), contentType: 'image/png' });

  await test.step('Correct password either signs in or displays the implemented cooldown', async () => {
    await password.fill(PASSWORD);
    const [body] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql')
        && r.request().postDataJSON()?.operationName === 'Login').then(r => r.json()),
      page.getByRole('button', { name: 'Sign in ->', exact: true }).click(),
    ]);
    let correctPasswordResult: object;
    if (body.errors?.length) {
      const error = body.errors[0];
      expect(error.extensions?.code).toBe('RATE_LIMITED');
      expect(error.extensions.retryAfterSeconds).toBeGreaterThan(0);
      expect(error.message).toBe('Too many requests. Try again later.');
      await expect(page.getByText(error.message, { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
      expect(body.data?.login).toBeFalsy();
      correctPasswordResult = { outcome: 'RATE_LIMITED', message: error.message,
        retryAfterSeconds: error.extensions.retryAfterSeconds };
    } else {
      expect(body.data.login.user).toBeTruthy();
      await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      correctPasswordResult = { outcome: 'SIGNED_IN' };
    }
    const result = { account: 'Hospital C', attempts, correctPasswordResult };
    await test.info().attach('invalid-login-results', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    await test.info().attach('correct-password-result', { body: await page.screenshot(), contentType: 'image/png' });
    console.log(JSON.stringify(result));
  });
});
