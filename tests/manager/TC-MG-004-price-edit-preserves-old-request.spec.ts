import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';

// Seeded, previously submitted and billed UAT request. No invoice is created or edited.
const REQUEST = 'REQ-2026-0036';
const HOSPITAL = 'DoctorCheck Demo Hospital';

async function requestSnapshot(page: Page) {
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    page.goto(`/manager/requests/${REQUEST}`),
  ]);
  expect(body.errors).toBeUndefined();
  const details = body.data.request.details;
  expect(details).toMatchObject({ requestNo: REQUEST, product: 'Cranium', material: 'PEEK', priceSizeBucketLabel: 'Small' });
  expect(details.priceBaseAmount).not.toBeNull();
  expect(details.quotedPrice).not.toBeNull();
  await expect(page.getByRole('heading', { name: `Request ${REQUEST}`, exact: true })).toBeVisible();
  const fields = ['priceBaseAmount', 'quotedPrice', 'priceCurrency', 'priceSizeBucketLabel',
    'priceAdjustmentType', 'priceAdjustmentPercent', 'priceAdjustmentAmount', 'priceCalculatedAt', 'financialAgencyUserId'];
  const data = Object.fromEntries(fields.map(key => [key, details[key]]));
  const base = await page.getByRole('term').filter({ hasText: /^Base price$/ }).locator('xpath=following-sibling::dd[1]').allTextContents();
  const quote = await page.getByRole('term').filter({ hasText: /^Calculated quote$/ }).locator('xpath=following-sibling::dd[1]').allTextContents();
  expect(base).toHaveLength(1);
  expect(quote.length).toBeGreaterThan(0);
  return { data, base, quote };
}

async function billSnapshot(page: Page) {
  await page.goto('/manager/billing');
  await page.getByRole('combobox', { name: 'Year', exact: true }).selectOption('2026');
  const [body] = await Promise.all([
    page.waitForResponse(async r => {
      if (!r.url().endsWith('/graphql') || r.request().postDataJSON()?.operationName !== 'BillingSummary') return false;
      const b = await r.json();
      return b.data?.billingSummary?.directPartnerGroups?.some((g: any) => g.requests.some((row: any) => row.requestNo === REQUEST));
    }).then(r => r.json()),
    page.getByRole('combobox', { name: 'Month', exact: true }).selectOption('9'),
  ]);
  expect(body.errors).toBeUndefined();
  const group = body.data.billingSummary.directPartnerGroups.find((g: any) => g.billedToName === HOSPITAL);
  const bill = group.requests.find((row: any) => row.requestNo === REQUEST);
  expect(bill.invoiceStatus).toBe('PAID');
  expect(Number(bill.amount)).toBeGreaterThan(0);
  await page.getByRole('row').filter({ has: page.getByRole('cell', { name: HOSPITAL, exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Open', exact: true }) })
    .getByRole('button', { name: 'Open', exact: true }).click();
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: REQUEST, exact: true }) });
  await expect(row).toBeVisible();
  return { bill, text: await row.innerText() };
}

async function priceInput(page: Page) {
  await page.goto('/manager/pricing');
  await expect(page.getByRole('heading', { name: 'Cranium / PEEK', exact: true })).toBeVisible();
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Small', exact: true }) })
    .getByRole('textbox', { name: 'New price', exact: true });
}

async function savePrice(page: Page, value: string) {
  const input = await priceInput(page);
  await input.fill(value);
  await page.getByRole('button', { name: 'Save all', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Save pricing changes?', exact: true });
  await confirmation.getByRole('button', { name: 'Save all changes', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save all', exact: true })).toBeDisabled();
  // Reopen to verify the persisted price, rather than just the input value.
  await expect(await priceInput(page)).toHaveValue(value);
}

test('TC-MG-004: Base price changes preserve an old request and its bill', async ({ page }) => {
  test.setTimeout(90000);
  await signIn(page, USERS.manager);
  const requestBefore = await requestSnapshot(page);
  const billBefore = await billSnapshot(page);
  const original = await (await priceInput(page)).inputValue();
  const changed = (Number(original) + 12345).toFixed(2);
  expect(Number(original)).toBeGreaterThan(0);
  test.info().annotations.push({ type: 'request', description: REQUEST });
  try {
    await test.step('Save a different base price for the same product, material and size', async () => {
      await savePrice(page, changed);
    });
    await test.step('Previously submitted request retains its frozen pricing', async () => {
      expect(await requestSnapshot(page)).toEqual(requestBefore);
    });
    await test.step('Existing bill retains its calculated amount, invoice amount and payment', async () => {
      expect(await billSnapshot(page)).toEqual(billBefore);
    });
  } finally {
    await test.step('Restore the original base price', async () => {
      const input = await priceInput(page);
      if (await input.inputValue() !== original) await savePrice(page, original);
      await expect(await priceInput(page)).toHaveValue(original);
    });
  }
});
