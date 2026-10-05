import { expect, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';

test('TC-MG-014: Zero and negative base prices are rejected without changing the saved price', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, USERS.manager);
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Small', exact: true }) });
  const input = row.getByRole('textbox', { name: 'New price', exact: true });
  const save = page.getByRole('button', { name: 'Save all', exact: true });
  async function openPricing() {
    await page.goto('/manager/pricing');
    await expect(page.getByRole('heading', { name: 'Cranium / PEEK', exact: true })).toBeVisible();
    await expect(input).not.toHaveValue('');
  }
  await openPricing();
  const original = await input.inputValue();
  expect(Number(original)).toBeGreaterThan(0);
  const results: object[] = [];
  try {
    for (const value of ['0', '-1']) {
      await test.step(`Base price ${value} is blocked with validation and does not persist`, async () => {
        await input.fill(value);
        if (await save.isEnabled()) {
          await save.click();
          const confirmation = page.getByRole('alertdialog', { name: 'Save pricing changes?', exact: true });
          if (await confirmation.isVisible()) {
            await confirmation.getByRole('button', { name: 'Save all changes', exact: true }).click();
          }
        }
        const validation = page.getByText(/(?:price|value|amount).*(?:positive|greater than (?:zero|0)|above (?:zero|0)|more than (?:zero|0))|(?:positive|greater than (?:zero|0)).*(?:price|value|amount)/i);
        await expect.soft(validation.first(), `Price ${value} must show a positive-price validation message`).toBeVisible();
        const messages = await validation.allTextContents();
        await test.info().attach(`price-${value}-validation`, { body: await page.screenshot(), contentType: 'image/png' });
        await openPricing();
        const persisted = await input.inputValue();
        expect.soft(persisted, `Invalid price ${value} must not replace ${original}`).toBe(original);
        results.push({ attemptedPrice: value, messages, original, persisted });
        // Stop if the invalid value was persisted; the finally block restores it.
        if (persisted !== original) throw new Error(`Invalid base price ${value} was saved`);
      });
    }
  } finally {
    await openPricing();
    if (await input.inputValue() !== original) {
      await input.fill(original);
      await save.click();
      const confirmation = page.getByRole('alertdialog', { name: 'Save pricing changes?', exact: true });
      await confirmation.getByRole('button', { name: 'Save all changes', exact: true }).click();
      await expect(confirmation).toBeHidden();
      await openPricing();
      await expect(input).toHaveValue(original);
    }
    await test.info().attach('positive-base-price-results', {
      body: JSON.stringify({ product: 'Cranium', material: 'PEEK', size: 'Small', results }, null, 2), contentType: 'application/json',
    });
    console.log(JSON.stringify({ product: 'Cranium / PEEK', size: 'Small', results }));
  }
});
