import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';
import { prepareHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

test('TC-HP-002: Submission is blocked without CT or Surgery type with clear validation', async ({ page }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, USERS.hospital);
  const code = `TC-HP-002-${randomUUID().slice(0, 8)}`;
  const submissionCalls: string[] = [];
  const results: object[] = [];
  page.on('request', request => {
    if (!request.url().endsWith('/graphql') || request.method() !== 'POST') return;
    const body = request.postDataJSON();
    if (/mutation/.test(body?.query ?? '') && /submitRequest/i.test(`${body?.operationName ?? ''} ${body?.query ?? ''}`)) {
      submissionCalls.push(body.operationName ?? 'submitRequest');
    }
  });

  async function attemptSubmission(expectedMessage: string, scenario: string) {
    await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
    const confirmation = page.getByRole('alertdialog', { name: 'Submit this request?', exact: true });
    // Some forms validate before confirmation; others validate on final submit.
    if (await confirmation.isVisible()) {
      await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
      await confirmation.getByRole('button', { name: 'Submit request', exact: true }).click();
    }
    const message = page.getByText(expectedMessage, { exact: true });
    await expect(message).toBeVisible();
    await expect(page).toHaveURL(/\/partner\/new$/);
    await expect(page.getByRole('heading', { name: 'New Request', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    expect(submissionCalls, 'Invalid form must not send a request-submission mutation').toHaveLength(0);
    await message.scrollIntoViewIfNeeded();
    await test.info().attach(scenario, { body: await page.screenshot(), contentType: 'image/png' });
    results.push({ scenario, message: await message.innerText(), stayedOnForm: true, submissionCalls: submissionCalls.length });
  }

  await test.step('Missing CT blocks an otherwise complete form', async () => {
    await prepareHospitalReworkRequest(page, `${code}-no-ct`, null);
    await expect(page.getByRole('combobox', { name: /^Surgery type\*/ }).locator('option:checked')).toHaveText('Cranioplasty');
    await attemptSubmission('CT file upload is required.', 'missing-ct');
  });

  await test.step('Empty Surgery type blocks a form with a synthetic CT attached', async () => {
    const ct = { ...syntheticCtRoundTwo, name: `${code}-ct.zip` };
    await prepareHospitalReworkRequest(page, `${code}-no-surgery`, ct);
    await page.getByRole('combobox', { name: /^Surgery type\*/ }).selectOption('');
    await expect(page.getByText(ct.name, { exact: true }).first()).toBeVisible();
    await attemptSubmission('Surgery type is required.', 'missing-surgery-type');
  });

  await test.info().attach('required-submission-results', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  console.log(JSON.stringify({ results, result: 'PASSED' }));
});
