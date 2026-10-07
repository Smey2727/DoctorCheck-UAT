import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';

async function login(page: Page, account: string) {
  const observed = page.waitForResponse(r => r.url().endsWith('/graphql')
    && r.request().postDataJSON()?.operationName === 'Login').then(r => r.json());
  observed.catch(() => {});
  try { return await signIn(page, account); }
  catch (error) {
    const body = await observed;
    const limit = body.errors?.find((entry: any) => entry.extensions?.code === 'RATE_LIMITED');
    if (!limit) throw error;
    const reason = `TC-AG-011 BLOCKED: ${account} login is rate limited; retry after ${limit.extensions.retryAfterSeconds} seconds.`;
    test.info().annotations.push({ type: 'blocked', description: reason });
    await test.info().attach('login-cooldown', { body: JSON.stringify({ account, retryAfterSeconds: limit.extensions.retryAfterSeconds }), contentType: 'application/json' });
    console.log(reason);
    test.skip(true, reason);
    throw error;
  }
}

async function billingClient(page: Page, role: 'manager' | 'partner') {
  const [captured] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'BillingSummary')
      .then(async r => ({ endpoint: r.url(), query: r.request().postDataJSON(),
        headers: r.request().headers().authorization ? { authorization: r.request().headers().authorization } : {},
        body: await r.json() })),
    page.goto(`/${role}/billing`),
  ]);
  expect(captured.body.errors).toBeUndefined();
  return async (year: number, month: number) => {
    const response = await page.request.post(captured.endpoint, {
      headers: captured.headers, data: { ...captured.query, variables: { year, month } },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    return [...body.data.billingSummary.agencyGroups, ...body.data.billingSummary.directPartnerGroups];
  };
}

// Each run consumes one PENDING UAT invoice. Run browser projects with --workers=1.
test('TC-AG-011: Agency Bills follows Manager PENDING to INVOICED to PAID without changing the amount', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const agencyUser = await login(page, USERS.agency);
  const agencyBilling = await billingClient(page, 'partner');
  const context = await browser.newContext({ baseURL });
  const history: object[] = [];
  let target: { requestNo: string; payerName: string; year: number; month: number; amount: string; currency: string } | undefined;
  try {
    const manager = await context.newPage();
    manager.setDefaultTimeout(15_000);
    await login(manager, USERS.manager);
    const managerBilling = await billingClient(manager, 'manager');
    const years = await manager.getByRole('combobox', { name: 'Year', exact: true }).locator('option')
      .evaluateAll(options => options.map(option => Number((option as HTMLOptionElement).value)));
    for (const year of years) {
      for (let month = 12; month >= 1; month--) {
        const groups = await managerBilling(year, month);
        const group = groups.find(g => g.billedToUserId === agencyUser.id && g.requests.some((r: any) =>
          r.invoiceStatus === 'PENDING' && Number(r.calculatedAmount) > 0 && Number(r.paidAmount) === 0));
        if (group) {
          const invoice = group.requests.find((r: any) => r.invoiceStatus === 'PENDING'
            && Number(r.calculatedAmount) > 0 && Number(r.paidAmount) === 0);
          target = { requestNo: invoice.requestNo, payerName: group.billedToName, year, month,
            amount: Number(invoice.amount ?? invoice.calculatedAmount).toFixed(2), currency: invoice.currency };
          break;
        }
      }
      if (target) break;
    }
    if (!target) {
      const reason = 'TC-AG-011 BLOCKED: No unpaid PENDING invoice was found for Agency 1 in the available billing periods.';
      test.info().annotations.push({ type: 'blocked', description: reason });
      await test.info().attach('no-pending-agency-invoice', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      console.log(reason);
      test.skip(true, reason);
      return;
    }
    const { requestNo, year, month, amount, currency } = target;
    test.info().annotations.push({ type: 'request', description: requestNo });
    async function refreshAgency(expectedStatus: string) {
      await page.reload();
      await page.getByRole('combobox', { name: 'Year', exact: true }).selectOption(String(year));
      await page.getByRole('combobox', { name: 'Month', exact: true }).selectOption(String(month));
      const groups = await agencyBilling(year, month);
      const group = groups.find(g => g.billedToUserId === agencyUser.id);
      expect(group).toBeDefined();
      const bill = group.requests.find((r: any) => r.requestNo === requestNo);
      expect(bill).toBeDefined();
      expect(bill.invoiceStatus).toBe(expectedStatus);
      expect(Number(bill.amount ?? bill.calculatedAmount).toFixed(2)).toBe(amount);
      expect(bill.currency).toBe(currency);
      await expect(page.getByRole('link', { name: requestNo, exact: true })).toBeVisible();
      console.log(await page.locator('main').ariaSnapshot());
      history.push({ status: expectedStatus, amount, currency, paidAmount: bill.paidAmount, outstanding: bill.outstanding });
      await test.info().attach(`agency-${expectedStatus.toLowerCase()}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    }
    await test.step('Agency sees the PENDING invoice', async () => refreshAgency('PENDING'));

    await manager.getByRole('combobox', { name: 'Year', exact: true }).selectOption(String(year));
    await manager.getByRole('combobox', { name: 'Month', exact: true }).selectOption(String(month));
    await manager.getByRole('row').filter({ hasText: target.payerName }).getByRole('button', { name: 'Open', exact: true }).click();
    const requestLink = manager.getByRole('link', { name: requestNo, exact: true });
    await test.step('Manager issues invoice; Agency refresh sees INVOICED with unchanged amount', async () => {
      const card = requestLink.locator('xpath=ancestor::div[.//button[normalize-space()="Issue invoice"]][1]');
      await expect(card.getByRole('textbox', { name: /^Invoice amount/ })).toHaveValue(amount);
      await card.getByRole('button', { name: 'Issue invoice', exact: true }).click();
      const confirm = manager.getByRole('alertdialog', { name: 'Issue this invoice?', exact: true });
      await confirm.getByRole('checkbox').check();
      await confirm.getByRole('button', { name: 'Issue invoice', exact: true }).click();
      await expect(confirm).toBeHidden();
      await refreshAgency('INVOICED');
    });
    await test.step('Manager records a full UAT payment; Agency refresh sees PAID with unchanged amount', async () => {
      const card = requestLink.locator('xpath=ancestor::div[.//button[normalize-space()="Record payment"]][1]');
      await card.getByRole('textbox', { name: /^Payment amount/ }).fill(amount);
      await card.getByRole('button', { name: 'Record payment', exact: true }).click();
      const confirm = manager.getByRole('alertdialog', { name: 'Record this payment?', exact: true });
      await confirm.getByRole('checkbox').check();
      await confirm.getByRole('button', { name: 'Record payment', exact: true }).click();
      await expect(confirm).toBeHidden();
      await refreshAgency('PAID');
      const groups = await agencyBilling(year, month);
      const bill = groups.find(g => g.billedToUserId === agencyUser.id).requests.find((r: any) => r.requestNo === requestNo);
      expect(Number(bill.outstanding)).toBe(0);
      expect(Number(bill.paidAmount).toFixed(2)).toBe(amount);
    });
  } finally {
    await test.info().attach('invoice-status-history', { body: JSON.stringify({ target, history }, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify({ target, history }));
    await context.close();
  }
});
