import { reuseSession } from './auth-state';
export { clearSession } from './auth-state';
import { Page, expect, test } from '@playwright/test';
import { waitForGraphqlResponse } from './graphql';

// Resolve login against the same baseURL as the rest of the test.
export const LOGIN_URL = '/login';

// Same password for all roles
export const PASSWORD = 'doctorcheck123';

// Email for each role
export const USERS = {
  manager: 'admin@saerosoft.com',
  hospital: 'partner@saerosoft.com',
  agency: 'agency.a@saerosoft.com',
  counselor: 'counselor@saerosoft.com',
  // Dedicated UAT review/operations account; design participation is disabled.
  counselorReview: 'uat-cs005-review',
};

// Use the app's language control on the login and account settings pages.
export async function selectEnglish(page: Page) {
  const languageSelect = page.getByRole('combobox', { name: 'Language', exact: true });
  await languageSelect.selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}

// Use the shared password by default, or a supplied test account password.
export async function signIn(page: Page, email: string, password = PASSWORD) {
  const reusableAccounts: string[] = [
    ...Object.values(USERS),
    'hospital.a@saerosoft.com',
    'hospital.b@saerosoft.com',
    'hospital.c@saerosoft.com',
    'agency.b@saerosoft.com',
  ];
  if (
    process.env.UAT_REUSE_AUTH === '0' ||
    password !== PASSWORD ||
    !reusableAccounts.includes(email)
  ) {
    return signInFresh(page, email, password);
  }
  return reuseSession(page, email, password, () => signInFresh(page, email, password));
}

// Authentication and session-lifecycle tests must call this instead of reusing state.
export async function signInFresh(page: Page, email: string, password = PASSWORD) {
  // Open the DoctorCheck login page
  await page.goto(LOGIN_URL);
  await selectEnglish(page);

  // Enter the email or login ID
  await page.getByRole('textbox', { name: 'ID or email*', exact: true }).fill(email);

  // Password field (name changes between "Show password" and "Hide password", so match both)
  const passwordBox = page.getByRole('textbox', { name: /^Password\*/ });

  // Enter the password
  await passwordBox.fill(password);

  // Check the "Stay signed in" checkbox
  await page.getByRole('checkbox', { name: 'Stay signed in on this' }).check();

  // Click "Show password" and verify the password is displayed
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(passwordBox).toHaveAttribute('type', 'text');

  // Click "Hide password" and verify the password is hidden again
  await page.getByRole('button', { name: 'Hide password' }).click();
  await expect(passwordBox).toHaveAttribute('type', 'password');

  // Read the login body before any subsequent full-page navigation can discard it.
  async function submitLogin() {
    const [body] = await Promise.all([
      waitForGraphqlResponse(page, 'Login').then((response) => response.json()),
      page.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ]);
    return body;
  }
  let loginBody = await submitLogin();
  const errors = loginBody.errors;
  const cooldown = Number(errors?.[0]?.extensions?.retryAfterSeconds);
  if (
    errors?.length === 1 &&
    errors[0].extensions?.code === 'RATE_LIMITED' &&
    Number.isFinite(cooldown) &&
    cooldown > 0 &&
    cooldown <= 900
  ) {
    // Respect the server's cooldown once; other errors still fail immediately.
    const waitMs = Math.ceil(cooldown * 1000) + 1000;
    const info = test.info();
    if (info.timeout > 0) info.setTimeout(info.timeout + waitMs);
    console.log(`Login rate limited; waiting ${Math.ceil(waitMs / 1000)}s before one retry.`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    loginBody = await submitLogin();
  }
  expect(loginBody.errors).toBeUndefined();
  const user = loginBody.data.login.user;

  // Verify the user left the login page.
  await expect(page, `Login did not complete for ${email}`).not.toHaveURL(/\/login/, {
    timeout: 15000,
  });

  // The saved account language can override the login page language.
  const landingUrl = page.url();
  await page.goto('/account');
  await selectEnglish(page);
  await page.goto(landingUrl);

  // Verify the Sign out button is visible (login succeeded)
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 15000 });
  return user;
}

// Sign out and verify the user is back on the login page
export async function signOut(page: Page) {
  // Click the Sign out button
  await page.getByRole('button', { name: 'Sign out' }).click();

  // Verify the user is returned to the login page
  await expect(page).toHaveURL(/\/login/);
}
