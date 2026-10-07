import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { PASSWORD, selectEnglish, signIn, signOut } from '../../helpers/auth';

// Agency 1 is the target account for TC-AG-007. Run browser projects sequentially.
const ACCOUNT = 'agency.a@saerosoft.com';
const WRONG_PASSWORD = 'UAT-deliberately-incorrect-password';

async function attemptLogin(page: Page, identity: string, password: string) {
  await page.getByRole('textbox', { name: 'Email or login ID*', exact: true }).fill(identity);
  await page.getByRole('textbox', { name: /^Password\*/ }).fill(password);
  const [body] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/graphql')
      && response.request().method() === 'POST'
      && response.request().postDataJSON()?.operationName === 'Login').then(response => response.json()),
    page.getByRole('button', { name: 'Sign in ->', exact: true }).click(),
  ]);
  return body;
}

async function expectRejection(page: Page, body: any) {
  expect(body.errors?.length).toBeGreaterThan(0);
  expect(body.data?.login).toBeFalsy();
  const error = body.errors[0];
  await expect(page.getByText(error.message, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.getByRole('textbox', { name: /^Password\*/ })).toHaveAttribute('type', 'password');
  expect(error.message).not.toMatch(/not found|does not exist|unknown (?:user|email|account)|incorrect password|wrong password/i);
  expect(error.message).not.toContain(ACCOUNT);
  const visibleText = await page.locator('body').innerText();
  expect(visibleText).not.toMatch(/stack trace|SQLException|Traceback|SQLSTATE|password hash|Exception:/i);
  expect(visibleText).not.toContain(WRONG_PASSWORD);
  return { message: error.message, code: error.extensions?.code,
    retryAfterSeconds: error.extensions?.retryAfterSeconds };
}

test('TC-AG-007: Invalid credentials are generic and repeated failures enforce lockout or allow correct login', async ({ page }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  const attempts: object[] = [];
  let unknownMessage: string;

  await test.step('Verify the account and correct password work before failed attempts', async () => {
    const user = await signIn(page, ACCOUNT);
    expect(user.accountStatus).toBe('ACTIVE');
    await signOut(page);
    await selectEnglish(page);
  });

  await test.step('Unknown email returns a generic credential error', async () => {
    const body = await attemptLogin(page, `uat-ag007-${randomUUID()}@example.invalid`, WRONG_PASSWORD);
    const error = await expectRejection(page, body);
    expect(error.code).not.toBe('RATE_LIMITED');
    expect(error.message).toMatch(/invalid credentials|invalid email or password|authentication failed|incorrect credentials/i);
    unknownMessage = error.message;
    attempts.push({ identity: 'nonexistent email', ...error });
  });

  for (let attempt = 1; attempt <= 5; attempt++) {
    await test.step(`Wrong password attempt ${attempt}: generic error or temporary rate limit`, async () => {
      const body = await attemptLogin(page, ACCOUNT, WRONG_PASSWORD);
      const error = await expectRejection(page, body);
      if (attempt === 1) expect(error.code, 'First failure must not start under an existing cooldown').not.toBe('RATE_LIMITED');
      if (error.code === 'RATE_LIMITED') {
        expect(error.message).toBe('Too many requests. Try again later.');
        expect(error.retryAfterSeconds).toBeGreaterThan(0);
      } else {
        // Same visible error for an existing and nonexistent email.
        expect(error.message).toBe(unknownMessage);
      }
      attempts.push({ attempt, ...error });
    });
  }
  await test.info().attach('repeated-wrong-password-result', { body: await page.screenshot(), contentType: 'image/png' });

  await test.step('Correct password after repeated failures is accepted or temporarily rate limited', async () => {
    const body = await attemptLogin(page, ACCOUNT, PASSWORD);
    let correctPasswordResult: object;
    if (body.errors?.length) {
      const error = await expectRejection(page, body);
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.message).toBe('Too many requests. Try again later.');
      expect(error.retryAfterSeconds).toBeGreaterThan(0);
      correctPasswordResult = { outcome: 'RATE_LIMITED', ...error };
    } else {
      expect(body.data.login.user).toMatchObject({ email: ACCOUNT, accountStatus: 'ACTIVE' });
      await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      correctPasswordResult = { outcome: 'SIGNED_IN' };
    }
    const result = { account: 'Agency 1', attempts, correctPasswordResult };
    await test.info().attach('invalid-credentials-and-lockout-results', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    await test.info().attach('correct-password-result', { body: await page.screenshot(), contentType: 'image/png' });
    console.log(JSON.stringify(result));
    if (!body.errors?.length) await signOut(page);
  });
});

