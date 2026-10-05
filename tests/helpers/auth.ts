import { Page, expect } from '@playwright/test';

// Login page URL
export const LOGIN_URL = 'https://doctorcheck.saerosoft.com/login';

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
  const languageToggle = page.locator('button[lang][aria-label]');
  await expect(languageToggle).toBeVisible();
  if (await languageToggle.getAttribute('lang') === 'en') {
    await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
  }
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}

// Use the shared password by default, or a supplied test account password.
export async function signIn(page: Page, email: string, password = PASSWORD) {
  // Open the DoctorCheck login page
  await page.goto(LOGIN_URL);
  await selectEnglish(page);

  // Enter the email or login ID
  await page.getByRole('textbox', { name: 'Email or login ID*' }).fill(email);

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
  const [loginBody] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/graphql')
      && response.request().method() === 'POST'
      && response.request().postDataJSON()?.operationName === 'Login')
      .then(response => response.json()),
    page.getByRole('button', { name: 'Sign in ->' }).click(),
  ]);
  expect(loginBody.errors).toBeUndefined();
  const user = loginBody.data.login.user;

  // Verify the user left the login page.
  await expect(page, `Login did not complete for ${email}`)
    .not.toHaveURL(/\/login/, { timeout: 15000 });

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
