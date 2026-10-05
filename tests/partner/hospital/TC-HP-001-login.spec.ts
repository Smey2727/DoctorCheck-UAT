import { test } from '@playwright/test';
import { signIn, signOut, USERS } from '../../helpers/auth';

test('TC-HP-001: Hospital Partner can sign in and sign out successfully', async ({ page }) => {
  // Sign in as Hospital Partner
  await signIn(page, USERS.hospital);

  // Sign out
  await signOut(page);
});
