import { test } from '@playwright/test';
import { signIn, signOut, USERS } from '../helpers/auth';

test('TC-MG-900: Manager can sign in and sign out successfully', async ({ page }) => {
  // Sign in as Manager
  await signIn(page, USERS.manager);

  // Sign out
  await signOut(page);
});
