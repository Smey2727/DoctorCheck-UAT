import { expect, test } from '@playwright/test';
import { waitForGraphqlResponse } from '../../helpers/graphql';
import { signIn } from '../../helpers/auth';

test('TC-HP-004: Hospital C without an agency sees the Cranial PEEK Small base price and direct billing', async ({
  page,
}) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(15_000);
  const user = await signIn(page, 'hospital.c@saerosoft.com');
  expect(user.role).toBe('PARTNER');
  const [agenciesBody] = await Promise.all([
    waitForGraphqlResponse(page, 'FinancialAgency').then((response) => response.json()),
    page.goto('/partner/new'),
  ]);
  expect(agenciesBody.errors).toBeUndefined();
  expect(agenciesBody.data.financialAgency).toBeNull();
  await expect(page.getByRole('heading', { name: 'New Request', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Hospital Set from your account/ })).toHaveValue(
    'Hospital C Medical Center',
  );
  const product = page.getByRole('button', { name: 'Product', exact: true });
  await expect(product).toBeVisible();
  if ((await product.getAttribute('aria-expanded')) !== 'true') await product.click();
  await page.getByRole('button', { name: 'Cranial Cranium - PEEK', exact: true }).click();
  await page.getByText('Prices by size', { exact: true }).click();

  await expect(
    page.getByRole('combobox', { name: /Financial agency|Billing account/i }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Direct billing to this partner account', { exact: true }),
  ).toBeVisible();
  const price = page
    .getByRole('group')
    .filter({ hasText: 'Prices by size' })
    .getByRole('listitem')
    .filter({ hasText: /^Small / });
  await expect(price).toHaveCount(1);
  await expect(price).toHaveText(/^Small .*KRW\s*900,000[.]00$/);
  await expect(price).toBeVisible();
  await price.scrollIntoViewIfNeeded();
  await test.info().attach('direct-hospital-base-price', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await test.info().attach('no-agency-base-price-results', {
    body: JSON.stringify(
      {
        hospital: 'Hospital C Medical Center',
        product: 'Cranial',
        material: 'PEEK',
        size: 'Small',
        activeAgencies: 0,
        agencySelectorPresent: false,
        billing: 'Direct billing to this partner account',
        displayedPrice: await price.innerText(),
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  console.log(
    JSON.stringify({
      hospital: 'Hospital C',
      product: 'Cranial / PEEK / Small',
      basePrice: '900000.00',
      currency: 'KRW',
      agencySelectorPresent: false,
      result: 'PASSED',
    }),
  );
});
