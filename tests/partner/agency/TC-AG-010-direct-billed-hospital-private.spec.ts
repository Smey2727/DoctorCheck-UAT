import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';

async function login(page: Page, account: string) {
  let cooldown: { message: string; retryAfterSeconds: number } | undefined;
  const observe = async (response: import('@playwright/test').Response) => {
    if (!response.url().endsWith('/graphql') || response.request().postDataJSON()?.operationName !== 'Login') return;
    const body = await response.json().catch(() => null);
    const error = body?.errors?.find((entry: any) => entry.extensions?.code === 'RATE_LIMITED');
    if (error) cooldown = { message: error.message, retryAfterSeconds: error.extensions.retryAfterSeconds };
  };
  // Read the login response alongside the helper before handling its assertion.
  const observed = page.waitForResponse(r => r.url().endsWith('/graphql')
    && r.request().postDataJSON()?.operationName === 'Login').then(observe);
  observed.catch(() => {});
  try {
    return await signIn(page, account);
  } catch (error) {
    await observed;
    if (!cooldown) throw error;
    const reason = `TC-AG-010 BLOCKED: ${account} login is rate limited; retry after ${cooldown.retryAfterSeconds} seconds. Privacy checks were not executed.`;
    test.info().annotations.push({ type: 'blocked', description: reason });
    await test.info().attach('login-cooldown', { body: JSON.stringify({ account, ...cooldown }), contentType: 'application/json' });
    console.log(reason);
    test.skip(true, reason);
    throw error;
  }
}

async function captureBilling(page: Page, role: 'manager' | 'partner') {
  const [captured] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'BillingSummary')
      .then(async r => ({ url: r.url(), data: r.request().postDataJSON(),
        headers: r.request().headers().authorization ? { authorization: r.request().headers().authorization } : {},
        body: await r.json() })),
    page.goto(`/${role}/billing`),
  ]);
  expect(captured.body.errors).toBeUndefined();
  return async (year: number, month: number) => {
    const response = await page.request.post(captured.url, {
      headers: captured.headers, data: { ...captured.data, variables: { year, month } },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    return body.data.billingSummary;
  };
}

test('TC-AG-010: Agency 1 cannot see a direct-billed Hospital C request or its bill', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  // Check the target Agency login first, before spending other login attempts.
  const agencyUser = await login(page, USERS.agency);
  expect(agencyUser.role).toBe('PARTNER');
  const context = await browser.newContext({ baseURL });
  try {
    const manager = await context.newPage();
    manager.setDefaultTimeout(15_000);
    await login(manager, USERS.manager);
    const managerBilling = await captureBilling(manager, 'manager');
    const years = await manager.getByRole('combobox', { name: 'Year', exact: true }).locator('option')
      .evaluateAll(options => options.map(option => Number((option as HTMLOptionElement).value)));
    let fixture: { requestNo: string; payerId: string; year: number; month: number } | undefined;
    await test.step('Find an existing Hospital C bill paid directly by Hospital C', async () => {
      for (const year of years) {
        for (let month = 12; month >= 1; month--) {
          const summary = await managerBilling(year, month);
          const group = summary.directPartnerGroups.find((entry: any) => !entry.viaAgency
            && entry.billedToName === 'Hospital C Medical Center'
            && entry.requests.some((bill: any) => bill.hospital === 'Hospital C Medical Center'));
          if (group) {
            const bill = group.requests.find((entry: any) => entry.hospital === 'Hospital C Medical Center');
            fixture = { requestNo: bill.requestNo, payerId: group.billedToUserId, year, month };
            break;
          }
        }
        if (fixture) break;
      }
      if (!fixture) {
        const reason = 'TC-AG-010 BLOCKED: No existing direct-billed Hospital C request was found in the available billing periods.';
        test.info().annotations.push({ type: 'blocked', description: reason });
        test.skip(true, reason);
        return;
      }
      expect(fixture.payerId).not.toBe(agencyUser.id);
    });
    const { requestNo, year, month } = fixture!;
    const [owned] = await Promise.all([
      manager.waitForResponse(r => r.url().endsWith('/graphql')
        && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
      manager.goto(`/manager/requests/${requestNo}`),
    ]);
    expect(owned.errors).toBeUndefined();
    expect(owned.data.request.details).toMatchObject({ requestNo, hospital: 'Hospital C Medical Center', financialAgencyUserId: null });
    const patientCode = owned.data.request.details.patientCode;
    expect(patientCode).toBeTruthy();

    await test.step('All requests search excludes the direct-billed Hospital C request', async () => {
      await page.goto('/account');
      await page.goto('/partner/requests');
      await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql')
          && r.request().postDataJSON()?.operationName === 'Requests').then(r => r.json()),
        page.getByRole('button', { name: /^All(?:,|$)/ }).click(),
      ]);
      await expect(page.getByRole('combobox', { name: 'Status', exact: true }).locator('option:checked')).toHaveText('All statuses');
      await expect(page.getByRole('combobox', { name: 'Last updated', exact: true }).locator('option:checked')).toHaveText('Any time');
      const [body] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql')
          && r.request().postDataJSON()?.operationName === 'Requests'
          && JSON.stringify(r.request().postDataJSON()?.variables).includes(requestNo)).then(r => r.json()),
        page.getByPlaceholder('Search request no - patient - product').fill(requestNo),
      ]);
      expect(body.errors).toBeUndefined();
      expect(body.data.requests).toMatchObject({ items: [], totalCount: 0 });
      await expect(page.getByRole('cell', { name: requestNo, exact: true })).toHaveCount(0);
      await test.info().attach('hospital-c-not-in-agency-list', { body: await page.screenshot(), contentType: 'image/png' });
    });

    await test.step('Direct URL returns access denied without request data', async () => {
      const [body] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql')
          && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
        page.goto(`/partner/requests/${requestNo}`),
      ]);
      expect(body.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ extensions: expect.objectContaining({ classification: 'FORBIDDEN' }) }),
      ]));
      expect(body.data?.request).toBeFalsy();
      await expect(page.getByRole('alert')).toHaveText('You do not have permission to perform this action.');
      await expect(page.locator('body')).not.toContainText(patientCode);
      await expect(page.getByRole('heading', { name: requestNo, exact: true })).toHaveCount(0);
      await test.info().attach('hospital-c-direct-url-denied', { body: await page.screenshot(), contentType: 'image/png' });
    });

    await test.step('Existing Hospital C bill is absent from Agency 1 billing', async () => {
      const summary = await (await captureBilling(page, 'partner'))(year, month);
      for (const group of [...summary.agencyGroups, ...summary.directPartnerGroups]) {
        expect(group.billedToUserId).toBe(agencyUser.id);
        expect(group.requests.some((bill: any) => bill.requestNo === requestNo)).toBe(false);
      }
      await page.getByRole('combobox', { name: 'Year', exact: true }).selectOption(String(year));
      await page.getByRole('combobox', { name: 'Month', exact: true }).selectOption(String(month));
      await expect(page.getByRole('heading', { name: 'Invoices by request', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: requestNo, exact: true })).toHaveCount(0);
      await test.info().attach('hospital-c-bill-excluded', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    });
    const result = { ...fixture, agency: 'Agency 1', directHospitalPayerVerified: true,
      absentFromList: true, directUrlDenied: true, billExcluded: true };
    await test.info().attach('direct-hospital-privacy-result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify(result));
  } finally {
    await context.close();
  }
});
