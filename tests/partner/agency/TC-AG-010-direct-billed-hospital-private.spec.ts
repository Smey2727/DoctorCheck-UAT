import { expect, Page, test } from '@playwright/test';
import { getAuthorizationHeaders, waitForGraphqlResponse } from '../../helpers/graphql';
import { signIn, USERS } from '../../helpers/auth';

async function captureBilling(page: Page, role: 'manager' | 'partner') {
  const [captured] = await Promise.all([
    waitForGraphqlResponse(page, 'BillingSummary').then(async (r) => ({
      url: r.url(),
      data: r.request().postDataJSON(),
      headers: getAuthorizationHeaders(r),
      body: await r.json(),
    })),
    page.goto(`/${role}/billing`),
  ]);
  expect(captured.body.errors).toBeUndefined();
  return async (year: number, month: number) => {
    const response = await page.request.post(captured.url, {
      headers: captured.headers,
      data: { ...captured.data, variables: { year, month } },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    return body.data.billingSummary;
  };
}

test('TC-AG-010: Agency 1 cannot see a direct-billed DoctorCheck Demo Hospital request or its bill', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  // Check the target Agency login first, before spending other login attempts.
  const agencyUser = await signIn(page, USERS.agency);
  expect(agencyUser.role).toBe('PARTNER');
  const context = await browser.newContext({ baseURL });
  try {
    const manager = await context.newPage();
    manager.setDefaultTimeout(15_000);
    await signIn(manager, USERS.manager);
    const managerBilling = await captureBilling(manager, 'manager');
    const requestNo = 'REQ-2026-0036';
    const year = 2026;
    const month = 9;
    const summary = await managerBilling(year, month);
    const group = summary.directPartnerGroups.find((entry: any) =>
      entry.requests.some((bill: any) => bill.requestNo === requestNo),
    );
    expect(group, 'The seeded direct-billed hospital invoice must exist').toBeDefined();
    expect(group).toMatchObject({ viaAgency: false, billedToName: 'DoctorCheck Demo Hospital' });
    expect(group.billedToUserId).not.toBe(agencyUser.id);
    const bill = group.requests.find((entry: any) => entry.requestNo === requestNo);
    expect(bill).toMatchObject({
      hospital: 'DoctorCheck Demo Hospital',
      invoiceStatus: 'PAID',
      currency: 'KRW',
    });
    expect(Number(bill.amount)).toBeGreaterThan(0);
    const fixture = { requestNo, payerId: group.billedToUserId, year, month };
    await test.info().attach('direct-hospital-bill-baseline', {
      body: JSON.stringify({ ...fixture, bill }, null, 2),
      contentType: 'application/json',
    });
    const [owned] = await Promise.all([
      waitForGraphqlResponse(manager, 'Request').then((response) => response.json()),
      manager.goto(`/manager/requests/${requestNo}`),
    ]);
    expect(owned.errors).toBeUndefined();
    expect(owned.data.request.details).toMatchObject({
      requestNo,
      hospital: 'DoctorCheck Demo Hospital',
      financialAgencyUserId: null,
    });
    const patientName = owned.data.request.details.patientName;
    expect(patientName).toBeTruthy();

    await test.step('All requests search excludes the direct-billed DoctorCheck Demo Hospital request', async () => {
      const [initial] = await Promise.all([
        waitForGraphqlResponse(page, 'Requests'),
        page.goto('/partner/requests'),
      ]);
      const {
        page: _page,
        size: _size,
        ...filters
      } = initial.request().postDataJSON().variables.input;
      expect(filters).toEqual({ partnerView: 'SUBMITTED' });
      const [body] = await Promise.all([
        page
          .waitForResponse(
            (r) =>
              r.url().endsWith('/graphql') &&
              r.request().postDataJSON()?.operationName === 'Requests' &&
              JSON.stringify(r.request().postDataJSON()?.variables).includes(requestNo),
          )
          .then((response) => response.json()),
        page.getByPlaceholder('Search patient, Hospital, doctor, or request no.').fill(requestNo),
      ]);
      expect(body.errors).toBeUndefined();
      expect(body.data.requests).toMatchObject({ items: [], totalCount: 0 });
      await expect(page.getByRole('cell', { name: requestNo, exact: true })).toHaveCount(0);
      await test.info().attach('direct-hospital-not-in-agency-list', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    });

    await test.step('Direct URL returns access denied without request data', async () => {
      const [body] = await Promise.all([
        waitForGraphqlResponse(page, 'Request').then((response) => response.json()),
        page.goto(`/partner/requests/${requestNo}`),
      ]);
      expect(body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            extensions: expect.objectContaining({ classification: 'FORBIDDEN' }),
          }),
        ]),
      );
      expect(body.data?.request).toBeFalsy();
      await expect(page.getByRole('alert')).toHaveText(
        'You do not have permission to perform this action.',
      );
      await expect(page.locator('body')).not.toContainText(patientName);
      await expect(page.getByRole('heading', { name: requestNo, exact: true })).toHaveCount(0);
      await test.info().attach('direct-hospital-direct-url-denied', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    });

    await test.step('Existing DoctorCheck Demo Hospital bill is absent from Agency 1 billing', async () => {
      const summary = await (await captureBilling(page, 'partner'))(year, month);
      for (const group of [...summary.agencyGroups, ...summary.directPartnerGroups]) {
        expect(group.billedToUserId).toBe(agencyUser.id);
        expect(group.requests.some((bill: any) => bill.requestNo === requestNo)).toBe(false);
      }
      await page.getByRole('combobox', { name: 'Year', exact: true }).selectOption(String(year));
      await page.getByRole('combobox', { name: 'Month', exact: true }).selectOption(String(month));
      await expect(
        page.getByRole('heading', { name: 'Invoices by request', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: requestNo, exact: true })).toHaveCount(0);
      await test.info().attach('direct-hospital-bill-excluded', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    });
    const result = {
      ...fixture,
      agency: 'Agency 1',
      directHospitalPayerVerified: true,
      absentFromList: true,
      directUrlDenied: true,
      billExcluded: true,
    };
    await test.info().attach('direct-hospital-privacy-result', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    console.log(JSON.stringify(result));
  } finally {
    await context.close();
  }
});
