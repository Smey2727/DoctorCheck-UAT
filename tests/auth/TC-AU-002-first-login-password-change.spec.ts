import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { selectEnglish, signIn, signOut, USERS } from '../helpers/auth';

async function login(page: Page, loginId: string, password: string) {
  await page.goto('/login');
  await selectEnglish(page);
  await page.getByRole('textbox', { name: 'Email or login ID*', exact: true }).fill(loginId);
  await page.getByRole('textbox', { name: /^Password\*/ }).fill(password);
  const [body] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/graphql')
      && response.request().method() === 'POST'
      && response.request().postDataJSON()?.operationName === 'Login').then(response => response.json()),
    page.getByRole('button', { name: 'Sign in ->', exact: true }).click(),
  ]);
  return body;
}

// A unique login-only account avoids changing shared users or sending email.
test('TC-AU-002: First login forces a password change and invalidates the temporary password', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const loginId = `uat-au002-${randomUUID().slice(0, 8)}`;
  const displayName = `TC-AU-002 ${loginId}`;
  const temporaryPassword = `Tmp!${randomUUID()}Aa1`;
  const newPassword = `New!${randomUUID()}Bb2`;
  test.info().annotations.push({ type: 'account', description: loginId });

  await test.step('Manager issues a temporary password for a new account', async () => {
    await signIn(page, USERS.manager);
    await page.goto('/manager/users');
    await page.getByRole('button', { name: '+ New account', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New account', exact: true });
    await dialog.getByRole('combobox', { name: 'Role*', exact: true }).selectOption('PARTNER');
    await dialog.getByRole('textbox', { name: 'Display name*', exact: true }).fill(displayName);
    await dialog.getByRole('textbox', { name: /^Login ID/ }).fill(loginId);
    await dialog.getByRole('textbox', { name: /^Temporary password\*/ }).fill(temporaryPassword);
    await dialog.getByRole('combobox', { name: 'Partner type*', exact: true }).selectOption({ label: 'Agency' });
    await dialog.getByRole('textbox', { name: 'Organization*', exact: true }).fill(`UAT ${loginId}`);
    await dialog.getByRole('textbox', { name: 'Phone / contact*', exact: true }).fill('010-0000-0000');
    await dialog.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: displayName, exact: true }) });
    await expect(row.getByRole('cell', { name: 'Active', exact: true })).toBeVisible();
  });

  const context = await browser.newContext({ baseURL });
  try {
    const partner = await context.newPage();
    await test.step('First login forces password change and blocks workspace navigation', async () => {
      const body = await login(partner, loginId, temporaryPassword);
      expect(body.errors).toBeUndefined();
      expect(body.data.login.user).toMatchObject({ loginId, mustChangePassword: true });
      await expect(partner).toHaveURL(/\/account$/);
      const heading = partner.getByRole('heading', { name: 'Change your temporary password', exact: true });
      await expect(heading).toBeVisible();
      await partner.getByRole('link', { name: /^My Requests(?:,|$)/ }).click();
      await expect(partner).toHaveURL(/\/account$/);
      await expect(partner.getByText('You must choose a private password before opening the rest of the workspace.', { exact: true })).toBeVisible();
      await partner.goto('/partner/requests');
      await expect(partner).toHaveURL(/\/account$/);
      await expect(heading).toBeVisible();
      await test.info().attach('forced-password-change', { body: await partner.screenshot(), contentType: 'image/png' });
    });

    await test.step('Change the temporary password', async () => {
      await partner.getByRole('textbox', { name: /^Current password\*/ }).fill(temporaryPassword);
      await partner.getByRole('textbox', { name: /^New password\*/ }).fill(newPassword);
      await partner.getByRole('textbox', { name: /^Confirm new password\*/ }).fill(newPassword);
      await partner.getByRole('button', { name: 'Update password', exact: true }).click();
      await expect(partner).toHaveURL(/\/login/);
    });
  } finally {
    await context.close();
  }

  // Fresh browser state proves neither result relies on the first-login session.
  const freshContext = await browser.newContext({ baseURL });
  try {
    const partner = await freshContext.newPage();
    await test.step('Temporary password is rejected after the change', async () => {
      const body = await login(partner, loginId, temporaryPassword);
      expect(body.errors?.length).toBeGreaterThan(0);
      expect(body.data?.login).toBeFalsy();
      const error = body.errors[0];
      expect(error.extensions?.code).not.toBe('RATE_LIMITED');
      expect(error.message).toMatch(/invalid|incorrect|credential|authentication failed/i);
      await expect(partner.getByText(error.message, { exact: true })).toBeVisible();
      await expect(partner).toHaveURL(/\/login(?:\?|$)/);
      await test.info().attach('temporary-password-rejected', { body: await partner.screenshot(), contentType: 'image/png' });
    });

    await test.step('New password signs in and permits workspace access', async () => {
      const body = await login(partner, loginId, newPassword);
      expect(body.errors).toBeUndefined();
      expect(body.data.login.user).toMatchObject({ loginId, mustChangePassword: false });
      await expect(partner).not.toHaveURL(/\/login(?:\?|$)/);
      await partner.getByRole('link', { name: /^My Requests(?:,|$)/ }).click();
      await expect(partner).toHaveURL(/\/partner\/requests(?:\?|$)/);
      await expect(partner.getByRole('heading', { name: 'My Requests', exact: true })).toBeVisible();
      await expect(partner.getByRole('heading', { name: 'Change your temporary password', exact: true })).toHaveCount(0);
      await test.info().attach('new-password-workspace-access', { body: await partner.screenshot(), contentType: 'image/png' });
      await signOut(partner);
    });
  } finally {
    await freshContext.close();
  }
});
