import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';

async function openAgency(page: Page, name: string) {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
function smallRule(page: Page) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Cranium', exact: true }) })
    .filter({ has: page.getByRole('cell', { name: 'PEEK', exact: true }) })
    .filter({ has: page.getByRole('cell', { name: 'Small', exact: true }) });
}

// Uses the dedicated Agency 1/2 accounts created by TC-MG-005. Only Agency 1's
// temporary rule is changed; the base price and existing contracts are preserved.
test('TC-MG-008: Agency 1 receives 10 percent discount and Agency 2 without a rule uses base price', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, USERS.manager);
  const [estimateRequest] = await Promise.all([
    page.waitForRequest(r => r.url().endsWith('/graphql') && r.postDataJSON()?.operationName === 'AgencyPriceEstimates'),
    page.goto('/manager/pricing'),
  ]);
  await expect(page.getByRole('heading', { name: 'Cranium / PEEK', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Small', exact: true }) })
    .getByRole('textbox', { name: 'New price', exact: true })).toHaveValue('900000.00');
  const originalEstimate = estimateRequest.postDataJSON();
  const headers = await estimateRequest.allHeaders();
  await page.getByRole('button', { name: 'Agency contract pricing', exact: true }).click();
  const firstAgency = page.getByRole('button', { name: /^TC-MG-005 Agency 1 / }).first();
  await expect(firstAgency, 'Create the dedicated UAT Agency 1/2 fixtures with TC-MG-005 first').toBeVisible();
  const agencyOne = (await firstAgency.innerText()).trim();
  const agencyTwo = agencyOne.replace('Agency 1', 'Agency 2');
  await openAgency(page, agencyOne);
  const agencyTwoId = await page.getByRole('combobox', { name: 'Target agency', exact: true })
    .getByRole('option', { name: agencyTwo, exact: true }).getAttribute('value');
  await expect(page.getByRole('button', { name: 'Remove rule', exact: true })).toHaveCount(0);
  await openAgency(page, agencyTwo);
  const agencyOneId = await page.getByRole('combobox', { name: 'Target agency', exact: true })
    .getByRole('option', { name: agencyOne, exact: true }).getAttribute('value');
  await expect(page.getByRole('button', { name: 'Remove rule', exact: true })).toHaveCount(0);
  expect(agencyOneId).toBeTruthy();
  expect(agencyTwoId).toBeTruthy();
  let added = false;
  try {
    await test.step('Save a -10 percent rule for Cranium / PEEK / Small under Agency 1', async () => {
      await openAgency(page, agencyOne);
      await page.getByRole('button', { name: '+ Add adjustment', exact: true }).click();
      await page.getByRole('combobox', { name: 'Product item', exact: true }).selectOption({ label: 'Cranium' });
      await page.getByRole('combobox', { name: 'Material', exact: true }).selectOption({ label: 'PEEK' });
      await page.getByRole('combobox', { name: 'Size bucket', exact: true }).selectOption({ label: 'Small' });
      await page.getByRole('combobox', { name: 'Type', exact: true }).selectOption({ label: 'Percent' });
      await page.getByRole('textbox', { name: 'New adjustment value', exact: true }).fill('-10');
      added = true;
      const [body] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql')
          && /mutation/.test(r.request().postDataJSON()?.query ?? '')).then(r => r.json()),
        page.getByRole('button', { name: 'Add', exact: true }).click(),
      ]);
      expect(body.errors).toBeUndefined();
      await expect(smallRule(page).getByRole('textbox', { name: 'Adjustment percent', exact: true })).toHaveValue('-10.00');
      await expect(smallRule(page)).toContainText('KRW 810,000.00');
    });
    await test.step('Verify server calculations for the same 900,000 price key', async () => {
      // Reuse the app's actual query and current authenticated session. The preview
      // normally uses Medium; Small is the 900,000 key specified in this UAT case.
      const response = await page.request.post(estimateRequest.url(), {
        headers: { authorization: headers.authorization, 'content-type': 'application/json' },
        data: { ...originalEstimate, variables: { ...originalEstimate.variables,
          sizeBucketLabel: 'Small', agencyUserIds: [agencyOneId, agencyTwoId] } },
      });
      expect(response.ok()).toBe(true);
      const body = await response.json();
      expect(body.errors).toBeUndefined();
      const estimates = body.data.agencyPriceEstimates;
      const discounted = estimates.find((entry: any) => entry.agencyUserId === agencyOneId);
      const noRule = estimates.find((entry: any) => entry.agencyUserId === agencyTwoId);
      expect(discounted).toBeDefined();
      expect(noRule).toBeDefined();
      test.info().annotations.push({ type: 'pricing', description:
        `${agencyOne}: ${discounted.amount}; ${agencyTwo} without rule: ${noRule.amount}; base: 900000.00 KRW` });
      expect(discounted.amount).toBe('810000.00');
      expect(noRule.amount, 'Agency 2 without a matching rule must fall back to 900,000 KRW').toBe('900000.00');
    });
  } finally {
    if (added) {
      test.setTimeout(test.info().timeout + 30_000);
      await test.step('Remove the temporary rule and preserve original pricing', async () => {
        await page.goto('/manager/pricing');
        await page.getByRole('button', { name: 'Agency contract pricing', exact: true }).click();
        await openAgency(page, agencyOne);
        await smallRule(page).getByRole('button', { name: 'Remove rule', exact: true }).click();
        const confirmation = page.getByRole('alertdialog');
        await confirmation.getByRole('button', { name: 'Remove rule', exact: true }).click();
        await expect(confirmation).toBeHidden();
        await expect(smallRule(page)).toHaveCount(0);
        await page.reload();
        await page.getByRole('button', { name: 'Agency contract pricing', exact: true }).click();
        await openAgency(page, agencyOne);
        await expect(page.getByRole('button', { name: 'Remove rule', exact: true })).toHaveCount(0);
      });
    }
  }
});
