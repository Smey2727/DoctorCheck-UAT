import { expect, test } from '@playwright/test';
import { signIn } from '../../helpers/auth';

// Agency 1 in the UAT case is the seeded Agency A connection for Hospital A.
test('TC-HP-005: Hospital A sole active agency is automatically selected', async ({ page }) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, 'hospital.a@saerosoft.com');
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'FinancialAgencies').then(r => r.json()),
    page.goto('/partner/new'),
  ]);
  expect(body.errors).toBeUndefined();
  expect(body.data.financialAgencies).toHaveLength(1);
  const agency = body.data.financialAgencies[0];
  await expect(page.getByRole('textbox', { name: /^Hospital Set from your account/ })).toHaveValue('Hospital A Medical Center');
  const agencySelect = page.getByRole('combobox', { name: /^Financial agency\*/ });
  await test.step('The sole active agency is selected without manual selection', async () => {
    await expect(agencySelect).toHaveValue(agency.id);
    await expect(agencySelect.locator('option:checked')).toHaveText('Agency A Distribution');
    await expect(agencySelect.locator('option[value]:not([value=""])')).toHaveCount(1);
    await agencySelect.scrollIntoViewIfNeeded();
    await test.info().attach('agency-auto-selected', { body: await page.screenshot(), contentType: 'image/png' });
  });
  await test.step('The agency remains selected after choosing a product; discounted pricing depends on configuration', async () => {
    await page.getByRole('combobox', { name: 'Product target*', exact: true }).selectOption({ label: 'PBH' });
    await page.getByRole('combobox', { name: /^Material\*/ }).selectOption({ label: 'PEEK' });
    await page.getByRole('combobox', { name: /^Detail type\*/ }).selectOption({ label: 'PBH - PEEK' });
    await expect(agencySelect).toHaveValue(agency.id);
    await expect(agencySelect.locator('option:checked')).toHaveText('Agency A Distribution');
    const size = page.getByRole('combobox', { name: /^Size bucket\*/ });
    const pricingUnavailable = page.getByText('No calculated quote is available. Ask a Manager to configure the applicable price.', { exact: true });
    // Wait for either usable prices or the application's explicit unavailable state.
    await expect(async () => {
      expect(await size.getByRole('option', { name: /^Small\b/ }).count() > 0 || await pricingUnavailable.isVisible()).toBe(true);
    }).toPass({ timeout: 15_000 });
    const pricing = await pricingUnavailable.isVisible()
      ? 'Unavailable for PBH / PEEK; discounted amount not verified'
      : 'Pricing is available; discount amount requires a configured discount pricing case';
    test.info().annotations.push({ type: 'pricing', description: pricing });
    await agencySelect.scrollIntoViewIfNeeded();
    await test.info().attach('single-agency-selection', { body: await page.screenshot(), contentType: 'image/png' });
    await test.info().attach('single-agency-results', {
      body: JSON.stringify({ hospital: 'Hospital A', product: 'PBH / PEEK / Small', agencyId: agency.id,
        selectedAgency: await agencySelect.locator('option:checked').innerText(), activeAgencies: 1,
        automaticallySelected: true, pricing }, null, 2), contentType: 'application/json',
    });
  });
  console.log(JSON.stringify({ hospital: 'Hospital A', agency: 'Agency A Distribution', autoSelected: true, result: 'PASSED' }));
});
