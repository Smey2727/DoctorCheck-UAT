import { test } from '@playwright/test';
import { signIn, signOut, USERS } from '../../helpers/auth';

test('TC-AG-001: Agency Partner can sign in and sign out successfully', async ({ page }) => {
  // Sign in as Agency Partner
  await signIn(page, USERS.agency);

  // Sign out
  await signOut(page);
});
