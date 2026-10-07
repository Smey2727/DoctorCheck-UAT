import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { selectEnglish, signIn, signOut, USERS } from '../helpers/auth';

async function login(page: Page, loginId: string, password: string) {
  await page.goto('/login');
  await selectEnglish(page);
  await page.getByRole('textbox', { name: 'Email or login ID*', exact: true }).fill(loginId);
  await page.getByRole('textbox', { name: /^Password\*/ }).fill(password);
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().method() === 'POST'
      && r.request().postDataJSON()?.operationName === 'Login').then(r => r.json()),
    page.getByRole('button', { name: 'Sign in ->', exact: true }).click(),
  ]);
  return body;
}

test('TC-AU-006: Manager resets a user password and the user signs in with the new temporary password', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const loginId = `uat-au006-${randomUUID().slice(0, 8)}`;
  const displayName = `TC-AU-006 ${loginId}`;
  const initialPassword = `Initial!${randomUUID()}Aa1`;
  const previousPassword = `Private!${randomUUID()}Bb2`;
  const resetPassword = `Reset!${randomUUID()}Cc3`;
  test.info().annotations.push({ type: 'account', description: loginId });

  await test.step('Create a dedicated login-only UAT account', async () => {
    await signIn(page, USERS.manager);
    await page.goto('/manager/users');
    await page.getByRole('button', { name: '+ New account', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New account', exact: true });
    await dialog.getByRole('combobox', { name: 'Role*', exact: true }).selectOption('PARTNER');
    await dialog.getByRole('textbox', { name: 'Display name*', exact: true }).fill(displayName);
    await dialog.getByRole('textbox', { name: /^Login ID/ }).fill(loginId);
    await dialog.getByRole('textbox', { name: /^Temporary password\*/ }).fill(initialPassword);
    await dialog.getByRole('combobox', { name: 'Partner type*', exact: true }).selectOption({ label: 'Agency' });
    await dialog.getByRole('textbox', { name: 'Organization*', exact: true }).fill(`UAT ${loginId}`);
    await dialog.getByRole('textbox', { name: 'Phone / contact*', exact: true }).fill('010-0000-0000');
    await dialog.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  const beforeContext = await browser.newContext({ baseURL });
  try {
    await test.step('Establish an existing user with a working private password', async () => {
      const userPage = await beforeContext.newPage();
      const initial = await login(userPage, loginId, initialPassword);
      expect(initial.errors).toBeUndefined();
      await expect(userPage.getByRole('heading', { name: 'Change your temporary password', exact: true })).toBeVisible();
      await userPage.getByRole('textbox', { name: /^Current password\*/ }).fill(initialPassword);
      await userPage.getByRole('textbox', { name: /^New password\*/ }).fill(previousPassword);
      await userPage.getByRole('textbox', { name: /^Confirm new password\*/ }).fill(previousPassword);
      await userPage.getByRole('button', { name: 'Update password', exact: true }).click();
      await expect(userPage).toHaveURL(/\/login/);
      const existing = await login(userPage, loginId, previousPassword);
      expect(existing.errors).toBeUndefined();
      expect(existing.data.login.user).toMatchObject({ loginId, mustChangePassword: false });
      await expect(userPage.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      await signOut(userPage);
    });
  } finally {
    await beforeContext.close();
  }

  await test.step('Manager resets only the dedicated account password', async () => {
    await page.reload();
    await page.getByRole('textbox', { name: 'Search name, email, login, organization, phone', exact: true }).fill(loginId);
    const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: displayName, exact: true }) });
    await expect(row).toContainText(loginId);
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('textbox', { name: /^Login ID/ })).toHaveValue(loginId);
    await dialog.getByRole('textbox', { name: /^Temporary password\*/ }).fill(resetPassword);
    await dialog.getByRole('textbox', { name: /^Confirm temporary password\*/ }).fill(resetPassword);
    const [resetBody] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql')
        && r.request().method() === 'POST'
        && /reset/i.test(r.request().postDataJSON()?.operationName ?? '')).then(r => r.json()),
      dialog.getByRole('button', { name: 'Reset password', exact: true }).click(),
    ]);
    expect(resetBody.errors).toBeUndefined();
    expect(resetBody.data).toBeTruthy();
    await dialog.getByRole('button', { name: 'Save account', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByRole('cell', { name: 'Active', exact: true })).toBeVisible();
    await test.info().attach('manager-reset-complete', { body: await page.screenshot(), contentType: 'image/png' });
  });

  const afterContext = await browser.newContext({ baseURL });
  try {
    const userPage = await afterContext.newPage();
    await test.step('Previous private password is rejected after reset', async () => {
      const body = await login(userPage, loginId, previousPassword);
      expect(body.errors?.length).toBeGreaterThan(0);
      expect(body.data?.login).toBeFalsy();
      expect(body.errors[0].extensions?.code).not.toBe('RATE_LIMITED');
      expect(body.errors[0].message).toMatch(/invalid credentials|authentication failed/i);
      await expect(userPage.getByText(body.errors[0].message, { exact: true })).toBeVisible();
      await expect(userPage).toHaveURL(/\/login/);
      await test.info().attach('previous-password-rejected', { body: await userPage.screenshot(), contentType: 'image/png' });
    });
    await test.step('Reset temporary password signs in and requires a private password', async () => {
      const body = await login(userPage, loginId, resetPassword);
      expect(body.errors).toBeUndefined();
      expect(body.data.login.user).toMatchObject({ loginId, accountStatus: 'ACTIVE', mustChangePassword: true });
      await expect(userPage).toHaveURL(/\/account$/);
      await expect(userPage.getByRole('heading', { name: 'Change your temporary password', exact: true })).toBeVisible();
      await expect(userPage.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      await test.info().attach('reset-temporary-password-login', { body: await userPage.screenshot(), contentType: 'image/png' });
      const result = { loginId, managerResetSucceeded: true, previousPasswordRejected: true,
        temporaryPasswordLoginSucceeded: true, mustChangePassword: true };
      await test.info().attach('password-reset-result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
      console.log(JSON.stringify(result));
      await signOut(userPage);
    });
  } finally {
    await afterContext.close();
  }
  await signOut(page);
});
