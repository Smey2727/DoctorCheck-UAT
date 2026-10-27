import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { waitForGraphqlResponse } from '../../helpers/graphql';
import { signIn, clearSession, USERS } from '../../helpers/auth';
import { prepareHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

// Cranial replaces the inactive PBH item. Submission freezes all size prices;
// the counselor selects the final size during design.
test('TC-AG-002: Agency submits its own Cranial PEEK request with a 900000 KRW Small price', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  const managerContext = await browser.newContext({ baseURL });
  const manager = await managerContext.newPage();
  manager.setDefaultTimeout(15_000);
  const addedRules: string[] = [];
  const rule = (size: string) =>
    manager
      .getByRole('row')
      .filter({ has: manager.getByRole('cell', { name: 'Cranial', exact: true }) })
      .filter({ has: manager.getByRole('cell', { name: 'PEEK', exact: true }) })
      .filter({ has: manager.getByRole('cell', { name: size, exact: true }) });
  async function openContract() {
    await manager.goto('/manager/pricing');
    await manager.getByRole('button', { name: 'Agency contract pricing', exact: true }).click();
    await Promise.all([
      waitForGraphqlResponse(manager, 'AgencyPricing'),
      manager.getByRole('button', { name: 'Agency A', exact: true }).click(),
    ]);
    await expect(manager.getByRole('heading', { name: 'Agency A', exact: true })).toBeVisible();
  }
  try {
    await signIn(manager, USERS.manager);
    await openContract();
    for (const size of ['Small', 'Medium', 'Large', 'Extra']) {
      if (await rule(size).count()) continue;
      await manager.getByRole('button', { name: '+ Add adjustment', exact: true }).click();
      await manager
        .getByRole('combobox', { name: 'Product item', exact: true })
        .selectOption({ label: 'Cranial' });
      await manager
        .getByRole('combobox', { name: 'Material', exact: true })
        .selectOption({ label: 'PEEK' });
      await manager
        .getByRole('combobox', { name: 'Size bucket', exact: true })
        .selectOption({ label: size });
      await manager
        .getByRole('combobox', { name: 'Type', exact: true })
        .selectOption({ label: 'Percent' });
      await manager.getByRole('textbox', { name: 'New adjustment value', exact: true }).fill('0');
      addedRules.push(size);
      await manager.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(rule(size)).toBeVisible();
    }
    const user = await signIn(page, USERS.agency);
    expect(user.role).toBe('PARTNER');
    const caseCode = `TC-AG-002-${randomUUID().slice(0, 8)}`;
    await prepareHospitalReworkRequest(
      page,
      caseCode,
      {
        ...syntheticCtRoundTwo,
        name: `${caseCode}-synthetic-ct.zip`,
      },
      undefined,
      'PEEK',
    );
    await page
      .getByRole('textbox', { name: 'Hospital*', exact: true })
      .fill('TC-AG-002 Synthetic Hospital');
    await expect(
      page.getByText('Direct billing to this partner account', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/KRW\s*900,000(?:\.00)?/).first()).toBeVisible();
    await test.info().attach('own-request-before-submit', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    await test.step('Submit and verify persisted size prices, status and direct billing', async () => {
      await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
      const confirmation = page.getByRole('alertdialog', {
        name: 'Submit this request?',
        exact: true,
      });
      await confirmation
        .getByRole('checkbox', { name: /^I reviewed the case details and files/ })
        .check();
      await confirmation.getByRole('button', { name: 'Submit request', exact: true }).click();
      await expect(page).toHaveURL(/\/partner\/requests\/REQ-\d{4}-\d+/);
      const requestId = new URL(page.url()).pathname.split('/').pop()!;
      test.info().annotations.push({ type: 'request', description: requestId });
      await expect(page.getByRole('heading', { name: requestId, exact: true })).toBeVisible();
      await page.goto('/account');
      const [body] = await Promise.all([
        waitForGraphqlResponse(page, 'Request').then((response) => response.json()),
        page.goto(`/partner/requests/${requestId}`),
      ]);
      expect(body.errors).toBeUndefined();
      const details = body.data.request.details;
      await test.info().attach('saved-own-request', {
        body: JSON.stringify(details, null, 2),
        contentType: 'application/json',
      });
      expect(details).toMatchObject({
        requestNo: requestId,
        status: 'SUBMITTED',
        financialAgencyUserId: null,
      });
      expect(details.lines).toHaveLength(1);
      const line = details.lines[0];
      expect(line).toMatchObject({ product: 'Cranial', material: 'PEEK' });
      expect(line.priceTable.currency).toBe('KRW');
      const small = line.priceTable.options.find(
        (option: any) => option.sizeBucketLabel === 'Small',
      );
      expect(small).toBeDefined();
      expect(Number(small.calculatedAmount)).toBe(900000);
      // Base prices and adjustment metadata are masked in the partner response.
      const [managerBody] = await Promise.all([
        waitForGraphqlResponse(manager, 'Request').then((response) => response.json()),
        manager.goto(`/manager/requests/${requestId}`),
      ]);
      expect(managerBody.errors).toBeUndefined();
      const saved = managerBody.data.request.details;
      expect(saved).toMatchObject({
        requestNo: requestId,
        financialAgencyUserId: null,
        hospital: 'TC-AG-002 Synthetic Hospital',
      });
      const savedSmall = saved.lines[0].priceTable.options.find(
        (option: any) => option.sizeBucketLabel === 'Small',
      );
      expect(savedSmall).toBeDefined();
      expect(Number(savedSmall.baseAmount)).toBe(900000);
      expect(Number(savedSmall.calculatedAmount)).toBe(900000);
      expect(Number(savedSmall.adjustmentPercent ?? 0)).toBe(0);
      expect(Number(savedSmall.adjustmentAmount ?? 0)).toBe(0);
      expect(savedSmall.calculatedAt).toBeTruthy();
      await expect(page.getByRole('button', { name: 'Submitted', exact: true })).toBeVisible();
      const billing = page
        .getByRole('term')
        .filter({ hasText: /^Billing account$/ })
        .locator('xpath=following-sibling::dd[1]');
      await expect(billing).toContainText(/Direct/i);
      await test.info().attach('submitted-own-request', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
      console.log(
        JSON.stringify({
          requestId,
          product: 'Cranial / PEEK',
          smallPrice: small.calculatedAmount,
          directBilling: true,
        }),
      );
    });
    await clearSession(page);
  } finally {
    test.setTimeout(test.info().timeout + 30_000);
    try {
      for (const size of addedRules) {
        await openContract();
        await rule(size).getByRole('button', { name: 'Remove rule', exact: true }).click();
        const confirmation = manager.getByRole('alertdialog');
        await confirmation.getByRole('button', { name: 'Remove rule', exact: true }).click();
        await expect(confirmation).toBeHidden();
        await expect(rule(size)).toHaveCount(0);
      }
    } finally {
      await managerContext.close();
    }
  }
});
