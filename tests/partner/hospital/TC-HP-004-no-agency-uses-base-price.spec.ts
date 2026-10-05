import { expect, test } from '@playwright/test';
import { signIn } from '../../helpers/auth';

test('TC-HP-004: Hospital C without an agency sees the PBH PEEK Small base price and direct billing', async ({ page }) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(15_000);
  const user = await signIn(page, 'hospital.c@saerosoft.com');
  expect(user.role).toBe('PARTNER');
  const [agenciesBody] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'FinancialAgencies').then(r => r.json()),
    page.goto('/partner/new'),
  ]);
  expect(agenciesBody.errors).toBeUndefined();
  expect(agenciesBody.data.financialAgencies).toHaveLength(0);
  await expect(page.getByRole('heading', { name: 'New Request', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Hospital Set from your account/ })).toHaveValue('Hospital C Medical Center');
  await page.getByRole('combobox', { name: 'Product target*', exact: true }).selectOption({ label: 'PBH' });
  await page.getByRole('combobox', { name: /^Material\*/ }).selectOption({ label: 'PEEK' });
  await page.getByRole('combobox', { name: /^Detail type\*/ }).selectOption({ label: 'PBH - PEEK' });
  const size = page.getByRole('combobox', { name: /^Size bucket\*/ });
  const small = size.getByRole('option', { name: /^Small\b/ });
  await expect(small).toHaveCount(1);
  await size.selectOption((await small.getAttribute('value'))!);
  await expect(size.locator('option:checked')).toHaveText(/^Small\b/);
  await expect(page.getByRole('combobox', { name: /Financial agency|Billing account/i })).toHaveCount(0);
  await expect(page.getByText('Direct billing to this partner account', { exact: true })).toBeVisible();
  const price = page.getByText(/KRW\s*900,000(?:\.00)?/).first();
  await expect(price).toBeVisible();
  await price.scrollIntoViewIfNeeded();
  await test.info().attach('direct-hospital-base-price', { body: await page.screenshot(), contentType: 'image/png' });
  await test.info().attach('no-agency-base-price-results', {
    body: JSON.stringify({ hospital: 'Hospital C Medical Center', product: 'PBH', material: 'PEEK', size: 'Small',
      activeAgencies: 0, agencySelectorPresent: false, billing: 'Direct billing to this partner account', displayedPrice: await price.innerText() }, null, 2),
    contentType: 'application/json',
  });
  console.log(JSON.stringify({ hospital: 'Hospital C', product: 'PBH / PEEK / Small', basePrice: '900000.00', currency: 'KRW', agencySelectorPresent: false, result: 'PASSED' }));
});
