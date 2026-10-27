import { expect, Page, test } from '@playwright/test';
import { getAuthorizationHeaders, waitForGraphqlResponse } from '../../helpers/graphql';
import { signIn, USERS } from '../../helpers/auth';

// Historical invoices retain their saved payer even after a connection ends.
// Bills are organized by shipment month, independently of current memberships.
const HOSPITALS = ['Hospital A Medical Center', 'Hospital B Medical Center'];
const PERIOD = { year: 2026, month: 9 };

async function billing(page: Page, role: 'manager' | 'partner') {
  const [captured] = await Promise.all([
    waitForGraphqlResponse(page, 'BillingSummary').then(async (r) => ({
      url: r.url(),
      query: r.request().postDataJSON(),
      headers: getAuthorizationHeaders(r),
      body: await r.json(),
    })),
    page.goto(`/${role}/billing`),
  ]);
  expect(captured.body.errors).toBeUndefined();
  const response = await page.request.post(captured.url, {
    headers: captured.headers,
    data: { ...captured.query, variables: PERIOD },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  const summary = body.data.billingSummary;
  return [...summary.agencyGroups, ...summary.directPartnerGroups];
}

test('TC-AG-008: Agency sees only bills naming it as payer across two Hospitals', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, USERS.manager);
  const [agencyBody] = await Promise.all([
    page
      .waitForResponse(
        async (r) =>
          r.url().endsWith('/graphql') &&
          r.request().postDataJSON()?.operationName === 'Agency' &&
          (await r.json().catch(() => null))?.data?.agency?.displayName === 'Agency A',
      )
      .then((response) => response.json()),
    (async () => {
      await page.goto('/manager/agencies');
      await page.getByRole('button', { name: /^Agency A Agency A Distribution / }).click();
    })(),
  ]);
  expect(agencyBody.errors).toBeUndefined();
  const agency = agencyBody.data.agency;
  const managerGroups = await billing(page, 'manager');
  const ownGroups = managerGroups.filter((group) => group.billedToUserId === agency.id);
  const expected = ownGroups.flatMap((group) => group.requests);
  const excluded = managerGroups
    .filter((group) => group.billedToUserId !== agency.id)
    .flatMap((group) => group.requests)
    .filter((bill: any) => HOSPITALS.includes(bill.hospital));
  expect(expected).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requestNo: 'REQ-2026-0059',
        hospital: 'Hospital B Medical Center',
      }),
    ]),
  );
  expect(excluded).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        requestNo: 'REQ-2026-0109',
        hospital: 'Hospital A Medical Center',
      }),
      expect.objectContaining({
        requestNo: 'REQ-2026-0061',
        hospital: 'Hospital B Medical Center',
      }),
      expect.objectContaining({
        requestNo: 'REQ-2026-0126',
        hospital: 'Hospital B Medical Center',
      }),
    ]),
  );

  await test.step('Compare Manager billing ownership against saved request payers', async () => {
    for (const bill of [...expected, ...excluded]) {
      const [body] = await Promise.all([
        waitForGraphqlResponse(page, 'Request').then((response) => response.json()),
        page.goto(`/manager/requests/${bill.requestNo}`),
      ]);
      expect(body.errors).toBeUndefined();
      const details = body.data.request.details;
      expect(details.requestNo).toBe(bill.requestNo);
      if (HOSPITALS.includes(bill.hospital)) {
        if (expected.includes(bill)) {
          expect(details.financialAgencyUserId).toBe(agency.id);
        } else {
          expect(details.financialAgencyUserId).not.toBe(agency.id);
        }
      }
    }
  });

  const context = await browser.newContext({ baseURL });
  try {
    const partner = await context.newPage();
    partner.setDefaultTimeout(15_000);
    const user = await signIn(partner, 'agency.a@saerosoft.com');
    expect(user.id).toBe(agency.id);
    const groups = await billing(partner, 'partner');
    for (const group of groups) {
      expect(group.billedToUserId).toBe(user.id);
    }
    const actual = groups.flatMap((group) => group.requests);
    const ids = (bills: any[]) => bills.map((bill) => bill.requestNo).sort();
    expect(ids(actual)).toEqual(ids(expected));
    for (const bill of excluded) {
      expect(ids(actual)).not.toContain(bill.requestNo);
    }
    await partner
      .getByRole('combobox', { name: 'Year', exact: true })
      .selectOption(String(PERIOD.year));
    await partner
      .getByRole('combobox', { name: 'Month', exact: true })
      .selectOption(String(PERIOD.month));
    for (const bill of expected) {
      await expect(partner.getByRole('link', { name: bill.requestNo, exact: true })).toBeVisible();
    }
    for (const bill of excluded) {
      await expect(partner.getByRole('link', { name: bill.requestNo, exact: true })).toHaveCount(0);
    }
    const result = {
      agency: 'Agency A',
      hospitals: HOSPITALS,
      period: PERIOD,
      includedRequests: ids(expected),
      excludedRequests: ids(excluded),
      savedPayersVerified: true,
    };
    await test.info().attach('payer-filter-result', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    await test.info().attach('agency-bills-by-payer', {
      body: await partner.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    console.log(JSON.stringify(result));
  } finally {
    await context.close();
  }
});
