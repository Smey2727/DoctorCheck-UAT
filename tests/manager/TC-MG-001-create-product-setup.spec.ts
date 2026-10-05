import { expect, test } from '@playwright/test';
import { signIn, signOut, USERS } from '../helpers/auth';

// TC-MG-001: Create product setup
// Category Cranium, item PBH, material PEEK, detail type PBH - PEEK
// Expected: all saved, active and shown on Partner form

test('TC-MG-001: Cranium PBH PEEK setup is active and available to partners', async ({ page }) => {
  // ---------- Manager: check the product setup ----------

  // Sign in as Manager
  await signIn(page, USERS.manager);

  // Open Reference Data
  await page.getByRole('link', { name: 'Reference Data' }).click();

  // Open the Categories / Items tab
  await page.getByRole('button', { name: 'Categories / Items' }).click();

  // Verify category Cranium exists
  await expect(page.getByText('Cranium', { exact: true }).first()).toBeVisible();

  // Verify item PBH exists
  await expect(page.getByText('PBH', { exact: true }).first()).toBeVisible();

  // Open the Materials tab
  await page.getByRole('button', { name: 'Materials' }).click();

  // Verify material PEEK exists
  await expect(page.getByText('PEEK', { exact: true }).first()).toBeVisible();

  // Open the Detail types tab
  await page.getByRole('button', { name: 'Detail types' }).click();

  // Select detail type Cranium / PBH / PEEK
  await page.getByRole('button', { name: /Cranium \/ PBH \/ PEEK/ }).click();

  // Verify the display name is "PBH - PEEK"
  await expect(page.getByRole('textbox', { name: 'Display name*' })).toHaveValue('PBH - PEEK');

  // Verify the detail type is Active
  await expect(page.getByRole('button', { name: 'Active', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Sign out Manager
  await signOut(page);

  // ---------- Partner: check PBH - PEEK is on the New Request form ----------

  // Sign in as Hospital Partner
  await signIn(page, USERS.hospital);

  // Open New Request from the menu
  await page.getByRole('link', { name: 'New Request', exact: true }).click();

  // Select product PBH
  await page.getByLabel('Product target*').selectOption({ label: 'PBH' });

  // Select material PEEK
  await page.getByLabel('Material*').selectOption({ label: 'PEEK' });

  // Verify detail type "PBH - PEEK" is offered
  const detailType = page.getByLabel('Detail type*');
  await expect(detailType.locator('option', { hasText: 'PBH - PEEK' })).toHaveCount(1);

  // Select detail type "PBH - PEEK" and verify it is selected
  await detailType.selectOption({ label: 'PBH - PEEK' });
  await expect(detailType.locator('option:checked')).toHaveText('PBH - PEEK');

  // Sign out Partner (nothing is saved)
  await signOut(page);
});
