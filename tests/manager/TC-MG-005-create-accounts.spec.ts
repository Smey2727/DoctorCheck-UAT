import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { selectEnglish, signIn, USERS } from '../helpers/auth';

async function partnerLogin(page: Page, loginId: string, password: string) {
  await page.goto('/login');
  await selectEnglish(page);
  await page.getByRole('textbox', { name: 'Email or login ID*', exact: true }).fill(loginId);
  await page.getByRole('textbox', { name: /^Password\*/ }).fill(password);
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Login').then(r => r.json()),
    page.getByRole('button', { name: 'Sign in ->', exact: true }).click(),
  ]);
  // Report errors without exposing the authentication response or passwords.
  expect(body.errors).toBeUndefined();
  return body.data.login.user;
}

// Unique login IDs keep repeated UAT runs independent of existing partner accounts.
// Login ID is sufficient, so creating these synthetic accounts sends no email.
test('TC-MG-005: Manager creates Hospital A, B, C and Agency 1, 2 with mandatory first-login password changes', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const runId = `uat-mg005-${randomUUID().slice(0, 8)}`;
  const accounts = [
    { label: 'Hospital A', type: 'Hospital' },
    { label: 'Hospital B', type: 'Hospital' },
    { label: 'Hospital C', type: 'Hospital' },
    { label: 'Agency 1', type: 'Agency' },
    { label: 'Agency 2', type: 'Agency' },
  ].map(account => ({ ...account,
    loginId: `${runId}-${account.label.toLowerCase().replace(' ', '-')}`,
    displayName: `TC-MG-005 ${account.label} ${runId.slice(-8)}`,
    temporaryPassword: `Tmp!${randomUUID()}Aa1`,
    newPassword: `New!${randomUUID()}Bb2`,
  }));
  await signIn(page, USERS.manager);
  await page.goto('/manager/users');
  for (const account of accounts) {
    await test.step(`Create active ${account.label} partner account`, async () => {
      await page.getByRole('button', { name: '+ New account', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'New account', exact: true });
      await dialog.getByRole('combobox', { name: 'Role*', exact: true }).selectOption('PARTNER');
      await dialog.getByRole('textbox', { name: 'Display name*', exact: true }).fill(account.displayName);
      await dialog.getByRole('textbox', { name: /^Login ID/ }).fill(account.loginId);
      await dialog.getByRole('textbox', { name: /^Temporary password\*/ }).fill(account.temporaryPassword);
      await dialog.getByRole('combobox', { name: 'Partner type*', exact: true }).selectOption({ label: account.type });
      if (account.type === 'Hospital') {
        await dialog.getByRole('textbox', { name: 'Hospital*', exact: true }).fill(account.label);
        await dialog.getByRole('button', { name: new RegExp(`^${account.label} Medical Center Accounts:`) }).click();
      } else {
        await dialog.getByRole('textbox', { name: 'Organization*', exact: true }).fill(`UAT ${account.label} ${runId.slice(-8)}`);
      }
      await dialog.getByRole('textbox', { name: 'Phone / contact*', exact: true }).fill('010-0000-0000');
      await dialog.getByRole('button', { name: 'Create account', exact: true }).click();
      await expect(dialog).toBeHidden();
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: account.displayName, exact: true }) });
      await expect(row.getByRole('cell', { name: 'Active', exact: true })).toBeVisible();
      await expect(row).toContainText(account.type);
      await expect(row).toContainText(account.loginId);
      test.info().annotations.push({ type: 'account', description: `${account.label}: ${account.loginId}` });
    });
    const context = await browser.newContext({ baseURL });
    try {
      const partner = await context.newPage();
      await test.step(`${account.label}: temporary password forces a password change`, async () => {
        const user = await partnerLogin(partner, account.loginId, account.temporaryPassword);
        expect(user).toMatchObject({ loginId: account.loginId, role: 'PARTNER', accountStatus: 'ACTIVE', mustChangePassword: true });
        await expect(partner).toHaveURL(/\/account$/);
        await expect(partner.getByRole('heading', { name: 'Change your temporary password', exact: true })).toBeVisible();
        await partner.getByRole('link', { name: /^My Requests(?:,|$)/ }).click();
        await expect(partner).toHaveURL(/\/account$/);
        await expect(partner.getByText('You must choose a private password before opening the rest of the workspace.', { exact: true })).toBeVisible();
        await partner.getByRole('textbox', { name: /^Current password\*/ }).fill(account.temporaryPassword);
        await partner.getByRole('textbox', { name: /^New password\*/ }).fill(account.newPassword);
        await partner.getByRole('textbox', { name: /^Confirm new password\*/ }).fill(account.newPassword);
        await partner.getByRole('button', { name: 'Update password', exact: true }).click();
        await expect(partner).toHaveURL(/\/login/);
      });
      await test.step(`${account.label}: new password signs in and unlocks the workspace`, async () => {
        const user = await partnerLogin(partner, account.loginId, account.newPassword);
        expect(user).toMatchObject({ loginId: account.loginId, role: 'PARTNER', accountStatus: 'ACTIVE', mustChangePassword: false });
        await partner.getByRole('link', { name: /^My Requests(?:,|$)/ }).click();
        await expect(partner).toHaveURL(/\/partner\/requests(?:\?|$)/);
        await expect(partner.getByRole('heading', { name: 'My Requests', exact: true })).toBeVisible();
        await expect(partner.getByRole('heading', { name: 'Change your temporary password', exact: true })).toHaveCount(0);
      });
    } finally { await context.close(); }
  }
  await test.step('All five accounts remain active after first-login password changes', async () => {
    await page.reload();
    await page.getByRole('textbox', { name: 'Search name, email, login, organization, phone', exact: true }).fill(runId);
    await expect(page.locator('tbody').getByRole('row')).toHaveCount(5);
    for (const account of accounts) {
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: account.displayName, exact: true }) });
      await expect(row.getByRole('cell', { name: 'Active', exact: true })).toBeVisible();
    }
  });
});
