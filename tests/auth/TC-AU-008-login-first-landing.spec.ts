import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { LOGIN_URL } from '../helpers/auth';

// Issue 1, customer review 2026-10-08. Inspected against the deployed DOM.
// signIn/selectEnglish use the previous UI and cannot be reused for this screen.
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page }) => {
  // Always enter through the configured base URL, never bypass the landing page.
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Language', exact: true }).selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
});

test('TC-AU-008: Signed-out application entry displays login by default', async ({ page }) => {
  await expect(page).toHaveURL(LOGIN_URL);
  await expect(page.getByRole('textbox', { name: 'ID or email*', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Password\*/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('TC-AU-008: Login displays branding, credentials, submit and Create Account', async ({
  page,
}) => {
  const brand = page.getByText('DoctorCheck', { exact: true });
  await expect.soft(brand).toBeVisible();
  // The real logo is an aria-hidden SVG beside the wordmark, not an img.
  await expect.soft(brand.locator('..').locator('span[aria-hidden="true"] > svg')).toBeVisible();
  await expect.soft(page.getByRole('textbox', { name: 'ID or email*', exact: true })).toBeVisible();
  await expect
    .soft(page.getByRole('textbox', { name: /^Password\*/ }))
    .toHaveAttribute('type', 'password');
  await expect.soft(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  // Required by the change request but absent in the inspected DOM. Do not invent a signup route.
  await expect
    .soft(
      page
        .getByRole('link', { name: /^Create account$/i })
        .or(page.getByRole('button', { name: /^Create account$/i })),
    )
    .toBeVisible();
});

test('TC-AU-008: First screen has no promotional headline or descriptive copy', async ({
  page,
}) => {
  // Historical copy is unavailable: enforce the observed login-only content boundary.
  await expect(page.getByRole('heading')).toHaveText(['Sign in']);
  await expect(page.locator('p:visible')).toHaveCount(0);
  const outsideForm = await page.getByRole('main').evaluate((main) => {
    const copy = main.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('form, select, svg').forEach((element) => element.remove());
    return copy.textContent?.replace(/\s+/g, ' ').trim();
  });
  expect(outsideForm).toBe('DoctorCheckLanguageSign in');
});

test('TC-AU-008: First screen has no workflow or status labels', async ({ page }) => {
  // A login-content allowlist catches old labels without guessing their wording.
  // Normalize CSS text-transform differences while checking all rendered text.
  const allowed = [
    'DoctorCheck',
    'Language',
    'English',
    '한국어',
    'Sign in',
    'ID or email*',
    'Password*',
    'Stay signed in on this browser for up to 14 days',
    'Forgot password?',
    'Create Account',
    'Create account',
  ];
  let remaining = (await page.locator('body').innerText()).toLowerCase();
  for (const text of allowed) {
    remaining = remaining.split(text.toLowerCase()).join('');
  }
  expect(remaining.replace(/\s+/g, ''), 'Only login content should be visible').toBe('');
});

test('TC-AU-008: Signed-out landing has no role dashboard links', async ({ page }) => {
  // These role roots are present in the deployed navigation and existing tests.
  const links = await page.getByRole('link').evaluateAll((elements) =>
    elements.map((element) => ({
      text: element.textContent ?? '',
      path: new URL((element as HTMLAnchorElement).href).pathname,
    })),
  );
  expect(
    links.filter(
      (link) =>
        /^\/(manager|counselor|partner)(\/|$)/.test(link.path) || /dashboard/i.test(link.text),
    ),
  ).toEqual([]);
});

test('TC-AU-008: Empty credentials show validation and keep the user signed out', async ({
  page,
}) => {
  await expect(page.getByRole('textbox', { name: 'ID or email*', exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: /^Password\*/ })).toHaveValue('');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Accept native required-field validation or the app's observed alert mechanism.
  // No hypothetical validation message is hard-coded.
  await expect.soft
    .poll(
      async () => {
        const nativeError = await page
          .locator('input')
          .evaluateAll((inputs) =>
            inputs.some(
              (input) =>
                input instanceof HTMLInputElement &&
                !input.validity.valid &&
                input.validationMessage.length > 0,
            ),
          );
        const alert = page.getByRole('alert');
        const appError = (await alert.isVisible()) && (await alert.innerText()).trim().length > 0;
        return nativeError || appError;
      },
      { message: 'Empty login must display validation feedback' },
    )
    .toBe(true);
  await expect(page).toHaveURL(LOGIN_URL);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('TC-AU-008: Invalid credentials are rejected with a visible error', async ({ page }) => {
  await page
    .getByRole('textbox', { name: 'ID or email*', exact: true })
    .fill(`uat-au008-${randomUUID()}@example.invalid`);
  await page
    .getByRole('textbox', { name: /^Password\*/ })
    .fill('UAT-deliberately-incorrect-password');
  const [body] = await Promise.all([
    page
      .waitForResponse(
        (response) =>
          response.url().endsWith('/graphql') &&
          response.request().method() === 'POST' &&
          response.request().postDataJSON()?.operationName === 'Login',
      )
      .then((response) => response.json()),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  expect(body.data?.login).toBeFalsy();
  expect(body.errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ message: 'Invalid credentials.' })]),
  );
  await expect(page.getByRole('alert')).toHaveText('Invalid credentials.');
  await expect(page).toHaveURL(LOGIN_URL);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});
