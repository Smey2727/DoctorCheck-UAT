import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';

// Requires Agency A to be connected to Hospital A and Hospital B. Bills are
// organized by shipment month; check saved payer selection, not only PAID status.
const HOSPITALS = ['Hospital A Medical Center', 'Hospital B Medical Center'];
const PERIOD = { year: 2026, month: 9 };

async function login(page: Page, account: string) {
  const response = page.waitForResponse(r => r.url().endsWith('/graphql')
    && r.request().postDataJSON()?.operationName === 'Login').then(r => r.json());
  // Observe the response immediately, including if navigation itself fails.
  response.catch(() => {});
  try {
    return await signIn(page, account);
  } catch (error) {
    const body = await response;
    const limit = body.errors?.find((entry: any) => entry.extensions?.code === 'RATE_LIMITED');
    if (!limit) throw error;
    const reason = `TC-AG-008 BLOCKED: ${account} login is rate limited; retry after ${limit.extensions.retryAfterSeconds} seconds. Billing checks were not completed.`;
    test.info().annotations.push({ type: 'blocked', description: reason });
    await test.info().attach('login-cooldown', { body: JSON.stringify({ account, message: limit.message,
      retryAfterSeconds: limit.extensions.retryAfterSeconds }), contentType: 'application/json' });
    console.log(reason);
    test.skip(true, reason);
    throw error;
  }
}

async function billing(page: Page, role: 'manager' | 'partner') {
  const [captured] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'BillingSummary')
      .then(async r => ({ url: r.url(), query: r.request().postDataJSON(),
        headers: r.request().headers().authorization ? { authorization: r.request().headers().authorization } : {},
        body: await r.json() })),
    page.goto(`/${role}/billing`),
  ]);
  expect(captured.body.errors).toBeUndefined();
  const response = await page.request.post(captured.url, {
    headers: captured.headers, data: { ...captured.query, variables: PERIOD },
  });
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  const summary = body.data.billingSummary;
  return [...summary.agencyGroups, ...summary.directPartnerGroups];
}

test('TC-AG-008: Agency connected to two Hospitals sees only bills naming it as payer', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await login(page, USERS.manager);
  const [agencyBody] = await Promise.all([
    page.waitForResponse(async r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Agency'
      && (await r.json().catch(() => null))?.data?.agency?.displayName === 'Agency A').then(r => r.json()),
    page.goto('/manager/agencies'),
  ]);
  expect(agencyBody.errors).toBeUndefined();
  const agency = agencyBody.data.agency;
  const activeMemberEmails = agency.members.filter((member: any) => member.active).map((member: any) => member.memberEmail);
  const missing = ['hospital.a@saerosoft.com', 'hospital.b@saerosoft.com'].filter(email => !activeMemberEmails.includes(email));
  if (missing.length) {
    const reason = `TC-AG-008 BLOCKED: Agency A requires active Hospital A and Hospital B connections. Missing active connection: ${missing.join(', ')}. Billing comparison was not executed.`;
    test.info().annotations.push({ type: 'blocked', description: reason });
    await test.info().attach('agency-connection-prerequisite', { body: JSON.stringify({ agency: agency.displayName,
      activeMemberEmails, missing }, null, 2), contentType: 'application/json' });
    await test.info().attach('agency-current-connections', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    console.log(reason);
    test.skip(true, reason);
    return;
  }
  const managerGroups = await billing(page, 'manager');
  const ownGroups = managerGroups.filter(group => group.billedToUserId === agency.id);
  const expected = ownGroups.flatMap(group => group.requests);
  const excluded = managerGroups.filter(group => group.billedToUserId !== agency.id)
    .flatMap(group => group.requests).filter((bill: any) => HOSPITALS.includes(bill.hospital));
  for (const hospital of HOSPITALS) {
    expect(expected.some((bill: any) => bill.hospital === hospital), `Positive billed request required for ${hospital}`).toBe(true);
  }
  expect(excluded.length, 'Need billed requests for the connected hospitals naming another payer').toBeGreaterThan(0);

  await test.step('Compare Manager billing ownership against saved request payers', async () => {
    for (const bill of [...expected, ...excluded]) {
      const [body] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql')
          && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
        page.goto(`/manager/requests/${bill.requestNo}`),
      ]);
      expect(body.errors).toBeUndefined();
      const details = body.data.request.details;
      expect(details.requestNo).toBe(bill.requestNo);
      if (HOSPITALS.includes(bill.hospital)) {
        if (expected.includes(bill)) expect(details.financialAgencyUserId).toBe(agency.id);
        else expect(details.financialAgencyUserId).not.toBe(agency.id);
      }
    }
  });

  const context = await browser.newContext({ baseURL });
  try {
    const partner = await context.newPage();
    partner.setDefaultTimeout(15_000);
    const user = await login(partner, 'agency.a@saerosoft.com');
    expect(user.id).toBe(agency.id);
    const groups = await billing(partner, 'partner');
    for (const group of groups) expect(group.billedToUserId).toBe(user.id);
    const actual = groups.flatMap(group => group.requests);
    const ids = (bills: any[]) => bills.map(bill => bill.requestNo).sort();
    expect(ids(actual)).toEqual(ids(expected));
    for (const bill of excluded) expect(ids(actual)).not.toContain(bill.requestNo);
    await partner.getByRole('combobox', { name: 'Year', exact: true }).selectOption(String(PERIOD.year));
    await partner.getByRole('combobox', { name: 'Month', exact: true }).selectOption(String(PERIOD.month));
    for (const bill of expected) await expect(partner.getByRole('link', { name: bill.requestNo, exact: true })).toBeVisible();
    for (const bill of excluded) await expect(partner.getByRole('link', { name: bill.requestNo, exact: true })).toHaveCount(0);
    const result = { agency: 'Agency A', hospitals: HOSPITALS, period: PERIOD,
      includedRequests: ids(expected), excludedRequests: ids(excluded), savedPayersVerified: true };
    await test.info().attach('payer-filter-result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    await test.info().attach('agency-bills-by-payer', { body: await partner.screenshot({ fullPage: true }), contentType: 'image/png' });
    console.log(JSON.stringify(result));
  } finally {
    await context.close();
  }
});
