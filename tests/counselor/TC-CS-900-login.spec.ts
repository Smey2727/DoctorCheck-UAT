import { test } from '@playwright/test';
import { signIn, signOut, USERS } from '../helpers/auth';

test('TC-CS-900: Counselor can sign in and sign out successfully', async ({ page }) => {
  // Sign in as Counselor
  await signIn(page, USERS.counselor);

  // Sign out
  await signOut(page);
});
