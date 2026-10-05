import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';
import { createHospitalReworkRequest } from '../helpers/requests';

const ITEM = 'Cranium';
function itemsSection(page: Page) {
  return page.getByRole('heading', { name: 'Product items', exact: true })
    .locator('xpath=ancestor::section[1]');
}
async function editItem(page: Page) {
  await page.goto('/manager/reference-data');
  await page.getByRole('button', { name: 'Categories / Items', exact: true }).click();
  const items = itemsSection(page);
  await items.getByRole('button', { name: 'Show turned off', exact: true }).click();
  // The item label precedes its category label, which can have the same name.
  const row = items.getByText(ITEM, { exact: true }).first().locator('xpath=ancestor::div[1]');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(items.getByRole('textbox', { name: 'Name*', exact: true })).toHaveValue(ITEM);
  return items;
}
async function setOffered(page: Page, offered: boolean) {
  const items = await editItem(page);
  const toggle = items.getByRole('checkbox', { name: 'Offered to partners', exact: true });
  if (await toggle.isChecked() !== offered) {
    await toggle.setChecked(offered);
    const [body] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql')
        && /mutation/.test(r.request().postDataJSON()?.query ?? ''), { timeout: 15_000 }).then(r => r.json()),
      (async () => {
        await items.getByRole('button', { name: 'Save', exact: true }).click();
        const confirmation = page.getByRole('alertdialog').filter({
          has: page.getByRole('heading', { name: offered ? 'Turn this product item back on?' : 'Turn off this product item?', exact: true }),
        });
        await expect(confirmation).toContainText(ITEM);
        await confirmation.getByRole('button', { name: offered ? 'Turn on' : 'Turn off', exact: true }).click();
        await expect(confirmation).toBeHidden();
      })(),
    ]);
    expect(body.errors).toBeUndefined();
    await expect(items.getByRole('checkbox', { name: 'Offered to partners', exact: true })).toHaveCount(0);
  }
  const persisted = await editItem(page);
  await expect(persisted.getByRole('checkbox', { name: 'Offered to partners', exact: true })).toBeChecked({ checked: offered });
  await expect(persisted.getByRole('button', { name: /delete/i })).toHaveCount(0);
}
async function oldRequest(page: Page, requestId: string) {
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    page.goto(`/manager/requests/${requestId}`),
  ]);
  expect(body.errors).toBeUndefined();
  const details = body.data.request.details;
  expect(details).toMatchObject({ requestNo: requestId, product: ITEM, material: 'Titanium', status: 'SUBMITTED' });
  await expect(page.getByRole('heading', { name: `Request ${requestId}`, exact: true })).toBeVisible();
  return Object.fromEntries(['detailTypeId', 'product', 'productCategory', 'material',
    'patientCode', 'priceSizeBucketLabel', 'status', 'statusHistory'].map(key => [key, details[key]]));
}
async function newForm(page: Page) {
  await page.goto('/partner/new');
  const product = page.getByRole('combobox', { name: 'Product target*', exact: true });
  // Wait for the catalog to load before asserting that one specific option is absent.
  await expect(product.getByRole('option', { name: 'PBH', exact: true })).toHaveCount(1);
  return product;
}

test('TC-MG-007: Disabled item disappears from new forms and remains on old requests', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const hospitalContext = await browser.newContext({ baseURL });
  let restore = false;
  try {
    await signIn(page, USERS.manager);
    const items = await editItem(page);
    await expect(items.getByRole('checkbox', { name: 'Offered to partners', exact: true })).toBeChecked();
    await expect(items.getByRole('button', { name: /delete/i })).toHaveCount(0);
    const hospitalPage = await hospitalContext.newPage();
    await signIn(hospitalPage, USERS.hospital);
    const requestId = await createHospitalReworkRequest(hospitalPage, `TC-MG-007-${randomUUID().slice(0, 8)}`);
    test.info().annotations.push({ type: 'request', description: requestId });
    const before = await oldRequest(page, requestId);
    await expect((await newForm(hospitalPage)).getByRole('option', { name: ITEM, exact: true })).toHaveCount(1);
    await test.step('Turn the item off and verify there is no delete action', async () => {
      restore = true;
      await setOffered(page, false);
    });
    await test.step('New partner form no longer offers the item', async () => {
      await expect((await newForm(hospitalPage)).getByRole('option', { name: ITEM, exact: true })).toHaveCount(0);
    });
    await test.step('Previously submitted request retains the disabled item', async () => {
      expect(await oldRequest(page, requestId)).toEqual(before);
      await hospitalPage.goto(`/partner/requests/${requestId}`);
      await expect(hospitalPage.getByRole('heading', { name: requestId, exact: true })).toBeVisible();
      await expect(hospitalPage.getByRole('term').filter({ hasText: /^Product$/ })
        .locator('xpath=following-sibling::dd[1]')).toContainText(ITEM);
    });
  } finally {
    try {
      if (restore) {
        test.setTimeout(test.info().timeout + 60_000);
        await test.step('Restore the item and verify it is available on new forms', async () => {
          await setOffered(page, true);
          const verifyPage = await hospitalContext.newPage();
          await expect((await newForm(verifyPage)).getByRole('option', { name: ITEM, exact: true })).toHaveCount(1);
        });
      }
    } finally { await hospitalContext.close(); }
  }
});

