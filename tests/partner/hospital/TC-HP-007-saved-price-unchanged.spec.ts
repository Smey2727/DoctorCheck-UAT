import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';
import { createHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

async function priceInput(page: Page) {
  await page.goto('/manager/pricing');
  await expect(page.getByRole('heading', { name: 'Cranium / PEEK', exact: true })).toBeVisible();
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Small', exact: true }) })
    .getByRole('textbox', { name: 'New price', exact: true });
}

async function savePrice(page: Page, value: string) {
  await (await priceInput(page)).fill(value);
  await page.getByRole('button', { name: 'Save all', exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Save pricing changes?', exact: true });
  await confirmation.getByRole('button', { name: 'Save all changes', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(page.getByRole('button', { name: 'Save all', exact: true })).toBeDisabled();
  await expect(await priceInput(page)).toHaveValue(value);
}

async function snapshot(page: Page, requestId: string) {
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    page.goto(`/manager/requests/${requestId}`),
  ]);
  expect(body.errors).toBeUndefined();
  const details = body.data.request.details;
  expect(details).toMatchObject({ requestNo: requestId, status: 'SUBMITTED',
    product: 'Cranium', material: 'PEEK', priceSizeBucketLabel: 'Small' });
  expect(Number(details.quotedPrice)).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: `Request ${requestId}`, exact: true })).toBeVisible();
  const fields = ['priceBaseAmount', 'quotedPrice', 'priceCurrency', 'priceSizeBucketLabel',
    'priceAdjustmentType', 'priceAdjustmentPercent', 'priceAdjustmentAmount',
    'priceCalculatedAt', 'financialAgencyUserId'];
  const data = Object.fromEntries(fields.map(key => [key, details[key]]));
  const base = await page.getByRole('term').filter({ hasText: /^Base price$/ })
    .locator('xpath=following-sibling::dd[1]').allTextContents();
  const quote = await page.getByRole('term').filter({ hasText: /^Calculated quote$/ })
    .locator('xpath=following-sibling::dd[1]').allTextContents();
  expect(base).toHaveLength(1);
  expect(quote.length).toBeGreaterThan(0);
  return { data, base, quote };
}

test('TC-HP-007: A submitted request keeps its saved price and agency after a Manager price change', async ({ page, browser }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, 'hospital.b@saerosoft.com');
  await page.goto('/partner/new');
  const agencyOption = page.getByRole('combobox', { name: /^Financial agency\*/ })
    .getByRole('option', { name: 'Agency B Distribution', exact: true });
  await expect(agencyOption).toHaveCount(1);
  const agencyId = (await agencyOption.getAttribute('value'))!;
  expect(agencyId).toBeTruthy();
  const code = `TC-HP-007-${randomUUID().slice(0, 8)}`;
  const requestId = await createHospitalReworkRequest(page, code,
    { ...syntheticCtRoundTwo, name: `${code}-synthetic-ct.zip` }, agencyId, 'PEEK');
  const billing = page.getByRole('term').filter({ hasText: /^Billing account$/ })
    .locator('xpath=following-sibling::dd[1]');
  await expect(billing).toContainText('Agency B Distribution');
  const billingBefore = await billing.innerText();
  test.info().annotations.push({ type: 'request', description: requestId });

  const context = await browser.newContext();
  const manager = await context.newPage();
  manager.setDefaultTimeout(15_000);
  try {
    await signIn(manager, USERS.manager);
    const before = await snapshot(manager, requestId);
    expect(before.data.financialAgencyUserId).toBe(agencyId);
    const original = await (await priceInput(manager)).inputValue();
    expect(Number(original)).toBeGreaterThan(0);
    const changed = (Number(original) + 12345).toFixed(2);
    try {
      await test.step('Manager saves a different base price', async () => {
        await savePrice(manager, changed);
      });
      await test.step('Saved quote and agency remain unchanged when reopening the submitted request', async () => {
        const after = await snapshot(manager, requestId);
        expect(after).toEqual(before);
        await page.goto(`/partner/requests/${requestId}`);
        await expect(page.getByRole('heading', { name: requestId, exact: true })
          .locator('..').getByRole('button', { name: 'Submitted', exact: true })).toBeVisible();
        await expect(billing).toHaveText(billingBefore);
        await test.info().attach('saved-price-and-agency', {
          body: JSON.stringify({ requestId, original, changed, before, after, billingBefore }, null, 2),
          contentType: 'application/json',
        });
        await test.info().attach('manager-saved-quote', { body: await manager.screenshot(), contentType: 'image/png' });
        await test.info().attach('hospital-saved-agency', { body: await page.screenshot(), contentType: 'image/png' });
        console.log(JSON.stringify({ requestId, savedPrice: before.data.quotedPrice,
          agency: billingBefore, originalBasePrice: original, temporaryBasePrice: changed }));
      });
    } finally {
      await test.step('Restore and verify the original base price', async () => {
        if (await (await priceInput(manager)).inputValue() !== original) await savePrice(manager, original);
        await expect(await priceInput(manager)).toHaveValue(original);
      });
    }
  } finally {
    await context.close();
  }
});
