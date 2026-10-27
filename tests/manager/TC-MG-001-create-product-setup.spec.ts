import { expect, test } from '@playwright/test';
import { signIn, clearSession, USERS } from '../helpers/auth';

// Verify the active catalog setup and its availability to partners.
// The legacy PBH item is turned off; Cranial is the current offered item.
test('TC-MG-001: Cranial PEEK setup is active and available to partners', async ({ page }) => {
  await signIn(page, USERS.manager);
  await page.getByRole('link', { name: 'Reference Data', exact: true }).click();
  await page.getByRole('button', { name: 'Categories / Items', exact: true }).click();
  await expect(page.getByText('Cranial', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Materials', exact: true }).click();
  await expect(page.getByText('PEEK', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Detail types', exact: true }).click();
  await page.getByRole('button', { name: 'Cranial / Cranial / PEEK', exact: true }).click();
  await expect(
    page.getByRole('combobox', { name: 'Product item*', exact: true }).locator('option:checked'),
  ).toHaveText('Cranial / Cranial');
  await expect(
    page.getByRole('combobox', { name: 'Material*', exact: true }).locator('option:checked'),
  ).toHaveText('PEEK');
  await expect(page.getByRole('textbox', { name: 'Display name*', exact: true })).toHaveValue(
    'Cranium - PEEK',
  );
  await expect(page.getByRole('button', { name: 'Active', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await clearSession(page);

  await signIn(page, USERS.hospital);
  await page.getByRole('link', { name: 'New Request', exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Material*', exact: true })
    .selectOption({ label: 'PEEK' });
  const product = page.getByRole('combobox', { name: 'Product*', exact: true });
  await product.click();
  const offered = page
    .getByRole('listbox', { name: 'Product', exact: true })
    .getByRole('option', { name: 'Cranial Cranial · Cranium - PEEK', exact: true });
  await expect(offered).toBeVisible();
  await offered.click();
  await expect(product).toHaveValue('Cranial');
  await clearSession(page);
});
