import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn } from '../../helpers/auth';
import { prepareHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

// The seeded Hospital B connections are Agency A / Agency B (Agency 1 / Agency 2).
test('TC-HP-006: Hospital B must choose an agency and can submit with either active connection', async ({ page }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, 'hospital.b@saerosoft.com');
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'FinancialAgencies').then(r => r.json()),
    page.goto('/partner/new'),
  ]);
  expect(body.errors).toBeUndefined();
  expect(body.data.financialAgencies).toHaveLength(2);
  const agencySelect = page.getByRole('combobox', { name: /^Financial agency\*/ });
  await expect(agencySelect).toHaveValue('');
  await expect(agencySelect.locator('option[value]:not([value=""])')).toHaveCount(2);
  const agencyA = await agencySelect.getByRole('option', { name: 'Agency A Distribution', exact: true }).getAttribute('value');
  const agencyB = await agencySelect.getByRole('option', { name: 'Agency B Distribution', exact: true }).getAttribute('value');
  expect(agencyA).toBeTruthy();
  expect(agencyB).toBeTruthy();
  const code = `TC-HP-006-${randomUUID().slice(0, 8)}`;
  const ct = { ...syntheticCtRoundTwo, name: `${code}-synthetic-ct.zip` };
  const results: object[] = [];
  const mutationCalls: string[] = [];
  page.on('request', request => {
    if (!request.url().endsWith('/graphql') || request.method() !== 'POST') return;
    const payload = request.postDataJSON();
    if (/mutation/.test(payload?.query ?? '')) mutationCalls.push(payload.operationName ?? 'mutation');
  });

  await test.step('No agency choice blocks submission with validation', async () => {
    // Complete the form with a priced product, then remove the agency choice.
    await prepareHospitalReworkRequest(page, `${code}-agency-a`, ct, agencyA!, 'PEEK');
    await agencySelect.selectOption('');
    await expect(agencySelect).toHaveValue('');
    const callsBeforeAttempt = mutationCalls.length;
    await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
    const confirmation = page.getByRole('alertdialog', { name: 'Submit this request?', exact: true });
    if (await confirmation.isVisible()) {
      await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
      await confirmation.getByRole('button', { name: 'Submit request', exact: true }).click();
    }
    const message = page.getByText('Select the financial agency for this request.', { exact: true });
    await expect(message).toBeVisible();
    await expect(page).toHaveURL(/\/partner\/new$/);
    expect(mutationCalls).toHaveLength(callsBeforeAttempt);
    results.push({ agency: null, blocked: true, message: await message.innerText() });
    await message.scrollIntoViewIfNeeded();
    await test.info().attach('no-agency-blocked', { body: await page.screenshot(), contentType: 'image/png' });
  });

  for (const agency of [{ id: agencyA!, name: 'Agency A Distribution' }, { id: agencyB!, name: 'Agency B Distribution' }]) {
    await test.step(`Request submits with ${agency.name} and retains its billing selection`, async () => {
      if (agency.id === agencyB) {
        await prepareHospitalReworkRequest(page, `${code}-agency-b`, ct, agency.id, 'PEEK');
      } else {
        await agencySelect.selectOption(agency.id);
        const size = page.getByRole('combobox', { name: /^Size bucket\*/ });
        const small = size.getByRole('option', { name: /^Small\b/ });
        await expect(small).toHaveCount(1);
        await size.selectOption((await small.getAttribute('value'))!);
      }
      await expect(agencySelect).toHaveValue(agency.id);
      await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
      const confirmation = page.getByRole('alertdialog', { name: 'Submit this request?', exact: true });
      await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql') && /mutation/.test(r.request().postDataJSON()?.query ?? '')).then(r => r.json()),
        confirmation.getByRole('button', { name: 'Submit request', exact: true }).click(),
      ]);
      expect(response.errors).toBeUndefined();
      await expect(page).toHaveURL(/\/partner\/requests\/REQ-\d{4}-\d+/);
      const requestId = new URL(page.url()).pathname.split('/').pop()!;
      await page.reload();
      await expect(page.getByRole('heading', { name: requestId, exact: true }).locator('..').getByRole('button', { name: 'Submitted', exact: true })).toBeVisible();
      const billing = page.getByRole('term').filter({ hasText: /^Billing account$/ }).locator('xpath=following-sibling::dd[1]');
      await expect(billing).toContainText(agency.name);
      results.push({ agency: agency.name, requestId, persistedStatus: 'SUBMITTED', billing: await billing.innerText() });
      test.info().annotations.push({ type: 'request', description: `${agency.name}: ${requestId}` });
      await test.info().attach(agency.name, { body: await page.screenshot(), contentType: 'image/png' });
    });
  }
  await test.info().attach('two-agency-results', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  console.log(JSON.stringify({ results, result: 'PASSED' }));
});
