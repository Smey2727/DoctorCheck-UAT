import { expect, test } from '@playwright/test';
import { signIn, signOut, USERS } from '../helpers/auth';

// TC-MG-003: Save base prices
// Small 900,000 / Medium 1,200,000 / Large 1,500,000 / Extra 1,900,000
// Expected: all sizes saved with KRW price

// Expected base price (KRW) for each size
const PRICES: Record<string, number> = {
  Small: 900000,
  Medium: 1200000,
  Large: 1500000,
  Extra: 1900000,
};

test('TC-MG-003: Base prices are saved for every size in KRW', async ({ page }) => {
  // Sign in as Manager and open Pricing
  await signIn(page, USERS.manager);
  await page.getByRole('link', { name: 'Pricing', exact: true }).click();

  // Verify Cranium / PEEK price table is shown
  await expect(page.getByRole('heading', { name: 'Cranium / PEEK' })).toBeVisible();

  for (const [size, price] of Object.entries(PRICES)) {
    // Find the row for this size
    const row = page.getByRole('row').filter({
      has: page.getByRole('cell', { name: size, exact: true }),
    });

    // Verify base price is shown in KRW (e.g. "KRW 900,000.00")
    const formatted = price.toLocaleString('en-US', { minimumFractionDigits: 2 });
    await expect(row).toContainText(`KRW ${formatted}`);

    // Verify the saved price in the New price box (e.g. "900000.00")
    await expect(row.getByRole('textbox', { name: 'New price' })).toHaveValue(price.toFixed(2));

    // Verify there are no unsaved changes for this size
    await expect(row).toContainText('same');
  }

  // Sign out
  await signOut(page);
});
