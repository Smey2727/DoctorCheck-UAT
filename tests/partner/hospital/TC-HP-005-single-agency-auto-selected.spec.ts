import { expect, test } from '@playwright/test';
import { waitForGraphqlResponse } from '../../helpers/graphql';
import { signIn, USERS } from '../../helpers/auth';
import { ensureAgencyCranialPeekPricing } from '../../helpers/requests';

// Agency 1 in the UAT case is the seeded Agency A connection for Hospital A.
test('TC-HP-005: Hospital A sole active agency is automatically selected', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  const managerContext = await browser.newContext({ baseURL });
  const manager = await managerContext.newPage();
  let cleanupPricing: (() => Promise<void>) | undefined;
  try {
    await signIn(manager, USERS.manager);
    cleanupPricing = await ensureAgencyCranialPeekPricing(manager);
    await signIn(page, 'hospital.a@saerosoft.com');
    const [body] = await Promise.all([
      waitForGraphqlResponse(page, 'FinancialAgency').then((response) => response.json()),
      page.goto('/partner/new'),
    ]);
    expect(body.errors).toBeUndefined();
    const agency = body.data.financialAgency;
    expect(agency).toMatchObject({ organizationName: 'Agency A Distribution' });
    expect(agency.id).toBeTruthy();
    await expect(
      page.getByRole('textbox', { name: /^Hospital Set from your account/ }),
    ).toHaveValue('Hospital A Medical Center');
    const assignedAgency = page.getByRole('textbox', { name: /^Financial agency/ });
    async function expectAssignedAgency() {
      await expect(assignedAgency).toHaveValue(agency.organizationName);
      await expect(assignedAgency).toBeDisabled();
      await expect(page.getByRole('combobox', { name: /Financial agency/i })).toHaveCount(0);
    }
    await test.step('Agency A is filled automatically without manual selection', async () => {
      await expectAssignedAgency();
    });
    await test.step('Agency A remains assigned after selecting an active product', async () => {
      const product = page.getByRole('button', { name: 'Product', exact: true });
      await expect(product).toBeVisible();
      if ((await product.getAttribute('aria-expanded')) !== 'true') await product.click();
      await page.getByRole('button', { name: 'Cranial Cranium - PEEK', exact: true }).click();
      await expect(product).toHaveText('PEEK · Cranial');
      await expectAssignedAgency();
      await assignedAgency.scrollIntoViewIfNeeded();
      await test.info().attach('single-agency-selection', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    });
    await test.step('Reload preserves the server-assigned agency', async () => {
      const [reloaded] = await Promise.all([
        waitForGraphqlResponse(page, 'FinancialAgency').then((response) => response.json()),
        page.reload(),
      ]);
      expect(reloaded.errors).toBeUndefined();
      expect(reloaded.data.financialAgency).toMatchObject({
        id: agency.id,
        organizationName: agency.organizationName,
      });
      await expectAssignedAgency();
    });
    const result = {
      hospital: 'Hospital A',
      agencyId: agency.id,
      agency: agency.organizationName,
      autoSelected: true,
      preservedAfterProductSelectionAndReload: true,
    };
    await test.info().attach('single-agency-results', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    console.log(JSON.stringify(result));
  } finally {
    test.setTimeout(test.info().timeout + 30_000);
    try {
      await cleanupPricing?.();
    } finally {
      await managerContext.close();
    }
  }
});
