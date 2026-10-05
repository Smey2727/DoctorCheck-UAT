import { expect, test } from '@playwright/test';
import { signIn, signOut, USERS } from '../helpers/auth';

// TC-MG-002: Add request fields
// Surgery type (pick one, required), Fixation holes (required), Width 5-120 mm
// Expected: fields shown on Partner form with required flag and limits

test('TC-MG-002: Required request fields and width limits are available to partners', async ({ page }) => {
  // Sign in as Hospital Partner and open New Request
  await signIn(page, USERS.hospital);
  await page.getByRole('link', { name: 'New Request', exact: true }).click();

  // Select product PBH, material PEEK, detail type PBH - PEEK
  await page.getByLabel('Product target*').selectOption({ label: 'PBH' });
  await page.getByLabel('Material*').selectOption({ label: 'PEEK' });
  await page.getByLabel('Detail type*').selectOption({ label: 'PBH - PEEK' });

  // Verify Surgery type is required (* in label) with its choices
  const surgeryType = page.getByRole('combobox', { name: /^Surgery type\*/ });
  await expect(surgeryType).toBeEnabled();
  await expect(surgeryType.locator('option')).toContainText(['Reconstruction', 'Cranioplasty', 'Revision']);

  // Verify Fixation holes is required (* in label) with its choices
  const fixationHoles = page.getByRole('combobox', { name: /^Fixation holes \/ mounting\*/ });
  await expect(fixationHoles).toBeVisible();
  await expect(fixationHoles.locator('option')).toContainText(['None', '4 holes', '6 holes']);

  // Verify Width limits are 5-120 mm
  const width = page.getByRole('spinbutton', { name: /^Width/ });
  await expect(width).toHaveAttribute('min', '5.000');
  await expect(width).toHaveAttribute('max', '120.000');

  // Verify Width outside the limits is rejected (4 and 121) and inside is accepted (50)
  await width.fill('4');
  expect(await width.evaluate((el: HTMLInputElement) => el.validity.rangeUnderflow)).toBe(true);
  await width.fill('121');
  expect(await width.evaluate((el: HTMLInputElement) => el.validity.rangeOverflow)).toBe(true);
  await width.fill('50');
  expect(await width.evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(true);

  // Sign out (nothing is saved)
  await signOut(page);
});
