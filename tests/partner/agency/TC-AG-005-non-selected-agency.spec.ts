import { expect, Page, test } from '@playwright/test';
import { signIn, signOut } from '../../helpers/auth';

const REQUESTS = ['REQ-2026-0673', 'REQ-2026-0061'];
const BILL_REQUEST = 'REQ-2026-0061';

async function requestDetails(page: Page, requestNo: string) {
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    page.goto(`/partner/requests/${requestNo}`),
  ]);
  return body;
}

async function septemberBilling(page: Page) {
  await page.goto('/partner/billing?year=2026&month=9');
  await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Year', exact: true }).selectOption('2026');
  await page.getByRole('combobox', { name: 'Month', exact: true }).selectOption('9');
  // Reload after selecting the period and read its actual authenticated query.
  const [captured] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'BillingSummary')
      .then(async r => ({ url: r.url(), query: r.request().postDataJSON(),
        authorization: r.request().headers().authorization, body: await r.json() })),
    page.reload(),
  ]);
  // Explicit read verifies the relevant shipment period even if the UI resets filters on reload.
  const response = await page.request.post(captured.url, {
    headers: captured.authorization ? { authorization: captured.authorization } : {},
    data: { ...captured.query, variables: { year: 2026, month: 9 } },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  const summary = body.data.billingSummary;
  return [...summary.agencyGroups, ...summary.directPartnerGroups];
}

test('TC-AG-005: Non-selected Agency 1 cannot list, open or see bills for Agency 2 requests', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const patientCodes = new Map<string, string>();
  let selectedAgencyId: string;

  await test.step('Selected Agency 2 can access both Hospital B requests and the existing bill', async () => {
    const selected = await signIn(page, 'agency.b@saerosoft.com');
    selectedAgencyId = selected.id;
    for (const requestNo of REQUESTS) {
      const body = await requestDetails(page, requestNo);
      expect(body.errors).toBeUndefined();
      expect(body.data.request.details).toMatchObject({ requestNo, hospital: 'Hospital B Medical Center', financialAgencyUserId: selected.id });
      patientCodes.set(requestNo, body.data.request.details.patientCode);
      await expect(page.getByRole('heading', { name: requestNo, exact: true })).toBeVisible();
    }
    const groups = await septemberBilling(page);
    const group = groups.find(group => group.requests.some((bill: any) => bill.requestNo === BILL_REQUEST));
    expect(group).toBeDefined();
    expect(group.billedToUserId).toBe(selected.id);
    const bill = group.requests.find((bill: any) => bill.requestNo === BILL_REQUEST);
    expect(bill).toMatchObject({ hospital: 'Hospital B Medical Center', amount: '1140000.00', currency: 'KRW' });
    await test.info().attach('selected-agency-bill-baseline', { body: JSON.stringify({ requestNo: BILL_REQUEST, amount: bill.amount, currency: bill.currency }), contentType: 'application/json' });
    await signOut(page);
  });

  const context = await browser.newContext({ baseURL });
  try {
    const agency = await context.newPage();
    agency.setDefaultTimeout(15_000);
    const user = await signIn(agency, 'agency.a@saerosoft.com');
    expect(user.role).toBe('PARTNER');
    expect(user.id).not.toBe(selectedAgencyId);

    await test.step('Both request numbers are absent from Agency 1 search results', async () => {
      await agency.goto('/account');
      await agency.goto('/partner/requests');
      await Promise.all([
        agency.waitForResponse(r => r.url().endsWith('/graphql')
          && r.request().postDataJSON()?.operationName === 'Requests').then(r => r.json()),
        agency.getByRole('button', { name: /^All(?:,|$)/ }).click(),
      ]);
      await expect(agency.getByRole('combobox', { name: 'Status', exact: true }).locator('option:checked')).toHaveText('All statuses');
      await expect(agency.getByRole('combobox', { name: 'Last updated', exact: true }).locator('option:checked')).toHaveText('Any time');
      for (const requestNo of REQUESTS) {
        const [body] = await Promise.all([
          agency.waitForResponse(r => r.url().endsWith('/graphql')
            && r.request().postDataJSON()?.operationName === 'Requests'
            && JSON.stringify(r.request().postDataJSON()?.variables).includes(requestNo)).then(r => r.json()),
          agency.getByPlaceholder('Search request no - patient - product').fill(requestNo),
        ]);
        expect(body.errors).toBeUndefined();
        expect(body.data.requests.items).toHaveLength(0);
        expect(body.data.requests.totalCount).toBe(0);
        await expect(agency.getByRole('cell', { name: requestNo, exact: true })).toHaveCount(0);
        await expect(agency.locator(`a[href$="/${requestNo}"]`)).toHaveCount(0);
      }
      await test.info().attach('non-selected-agency-empty-search', { body: await agency.screenshot(), contentType: 'image/png' });
    });

    await test.step('Pasted request URLs deny access and return no request data', async () => {
      for (const requestNo of REQUESTS) {
        const body = await requestDetails(agency, requestNo);
        expect(body.errors?.length).toBeGreaterThan(0);
        expect(body.data?.request).toBeFalsy();
        expect(body.errors).toEqual(expect.arrayContaining([
          expect.objectContaining({ extensions: expect.objectContaining({ classification: 'FORBIDDEN' }) }),
        ]));
        await expect(agency.getByRole('alert')).toHaveText('You do not have permission to perform this action.');
        await expect(agency.getByRole('heading', { name: requestNo, exact: true })).toHaveCount(0);
        expect(patientCodes.get(requestNo)).toBeTruthy();
        await expect(agency.locator('body')).not.toContainText(patientCodes.get(requestNo)!);
        await test.info().attach(`${requestNo}-denied`, { body: await agency.screenshot(), contentType: 'image/png' });
      }
    });

    await test.step('Agency 2 bill is absent from Agency 1 billing for the same shipment period', async () => {
      const groups = await septemberBilling(agency);
      for (const group of groups) {
        expect(group.billedToUserId).toBe(user.id);
        expect(group.requests.some((bill: any) => REQUESTS.includes(bill.requestNo))).toBe(false);
      }
      await agency.getByRole('combobox', { name: 'Year', exact: true }).selectOption('2026');
      await agency.getByRole('combobox', { name: 'Month', exact: true }).selectOption('9');
      await expect(agency.getByRole('heading', { name: 'Invoices by request', exact: true })).toBeVisible();
      for (const requestNo of REQUESTS) await expect(agency.getByRole('link', { name: requestNo, exact: true })).toHaveCount(0);
      await test.info().attach('non-selected-agency-billing', { body: await agency.screenshot({ fullPage: true }), contentType: 'image/png' });
    });
    const result = { nonSelectedAgency: 'Agency A / Agency 1', selectedAgency: 'Agency B / Agency 2',
      requestNumbers: REQUESTS, absentFromList: true, directUrlForbidden: true,
      existingBillExcluded: BILL_REQUEST, billingPeriod: '2026-09' };
    await test.info().attach('non-selected-agency-result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify(result));
    await signOut(agency);
  } finally {
    await context.close();
  }
});
