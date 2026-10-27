import { expect, test } from '@playwright/test';
import { signIn, clearSession } from '../../helpers/auth';

const REQUEST_NO = 'REQ-2026-0061';
const AMOUNT = '1140000.00';

// Existing Hospital B invoice shipped in September 2026 and billed to Agency B.
test('TC-AG-004: Agency 2 sees its assigned bill for 1140000 KRW', async ({ page }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const user = await signIn(page, 'agency.b@saerosoft.com');
  expect(user.role).toBe('PARTNER');
  const [response] = await Promise.all([
    page.waitForResponse((r) => {
      if (!r.url().endsWith('/graphql') || r.request().method() !== 'POST') return false;
      const query = r.request().postDataJSON();
      return (
        query?.operationName === 'BillingSummary' &&
        Number(query.variables?.year) === 2026 &&
        Number(query.variables?.month) === 9
      );
    }),
    (async () => {
      await page.goto('/partner/billing');
      await page.getByRole('combobox', { name: 'Year', exact: true }).selectOption('2026');
      await page.getByRole('combobox', { name: 'Month', exact: true }).selectOption('9');
    })(),
  ]);
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  const summary = body.data.billingSummary;
  const groups = [...summary.agencyGroups, ...summary.directPartnerGroups];
  for (const group of groups) {
    expect(group.billedToUserId, 'All visible bills must belong to Agency B').toBe(user.id);
  }
  const group = groups.find((entry: any) =>
    entry.requests.some((bill: any) => bill.requestNo === REQUEST_NO),
  );
  expect(group, 'The expected invoice must be present in September 2026').toBeDefined();
  expect(group.billedToUserId).toBe(user.id);
  const invoice = group.requests.find((bill: any) => bill.requestNo === REQUEST_NO);
  expect(invoice).toMatchObject({
    requestNo: REQUEST_NO,
    hospital: 'Hospital B Medical Center',
    amount: AMOUNT,
    currency: 'KRW',
    invoiceStatus: 'PAID',
    paidAmount: AMOUNT,
    outstanding: '0.00',
  });
  expect(invoice.invoicedAt).toBeTruthy();
  await expect(page).toHaveURL(/\/partner\/billing(?:\?|$)/);
  await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
  const requestLink = page.getByRole('link', { name: REQUEST_NO, exact: true });
  await expect(requestLink).toBeVisible();
  const card = requestLink.locator(
    'xpath=ancestor::div[.//button[normalize-space()="Transaction statement"]][1]',
  );
  await expect(card).toContainText('Hospital B Medical Center');
  await expect(card).toContainText('KRW 1,140,000.00');
  await expect(card).toContainText(/paid/i);
  await test.info().attach('assigned-agency-invoice', {
    body: JSON.stringify(
      { payerId: group.billedToUserId, payer: group.billedToName, year: 2026, month: 9, invoice },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  await test.info().attach('agency-billing-1140000', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  console.log(
    JSON.stringify({
      requestNo: REQUEST_NO,
      amount: AMOUNT,
      currency: 'KRW',
      invoiceStatus: invoice.invoiceStatus,
      correctAgency: true,
    }),
  );
  await clearSession(page);
});
