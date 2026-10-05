import { test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';

test('TC-MG-006: Manager can edit an account and reset its password', async ({ page }) => {
  // Sign in as Manager
  await signIn(page, USERS.manager);

  // Open the Users page from the menu
  await page.getByRole('link', { name: 'Users' }).click();

  // Click "Edit" on the 3rd user in the list
  await page.getByRole('button', { name: 'Edit' }).nth(2).click();

  // Change the display name
  await page.getByRole('textbox', { name: 'Display name*' }).fill('smey123');

  // Change the login ID
  await page.getByRole('textbox', { name: 'Login ID Optional when email' }).fill('smy123.login');

  // Enter a new temporary password (at least 8 characters)
  await page.getByRole('textbox', { name: /^Temporary password\*/ }).fill('12345678');

  // Enter the same temporary password again to confirm
  await page.getByRole('textbox', { name: 'Confirm temporary password*' }).fill('12345678');

  // Click "Reset password"
  await page.getByRole('button', { name: 'Reset password' }).click();

  // Click "Save account"
  await page.getByRole('button', { name: 'Save account' }).click();
});
