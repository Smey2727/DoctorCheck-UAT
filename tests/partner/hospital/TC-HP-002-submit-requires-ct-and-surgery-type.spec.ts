import { randomUUID } from 'node:crypto';
import { expect, Locator, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';
import { prepareHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

test('TC-HP-002: Submission is blocked without CT or planned surgery date with clear validation', async ({
  page,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, USERS.hospital);
  const code = `TC-HP-002-${randomUUID().slice(0, 8)}`;
  const submissionCalls: string[] = [];
  const results: object[] = [];
  page.on('request', (request) => {
    if (!request.url().endsWith('/graphql') || request.method() !== 'POST') {
      return;
    }
    const body = request.postDataJSON();
    if (
      /mutation/.test(body?.query ?? '') &&
      /submitRequest/i.test(`${body?.operationName ?? ''} ${body?.query ?? ''}`)
    ) {
      submissionCalls.push(body.operationName ?? 'submitRequest');
    }
  });

  async function attemptSubmission(field: Locator, scenario: string, message?: string) {
    await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
    const confirmation = page.getByRole('alertdialog', {
      name: 'Submit this request?',
      exact: true,
    });
    if (message) {
      await expect(page.getByText(message, { exact: true })).toBeVisible();
    } else {
      await expect(field).toHaveAttribute('aria-invalid', 'true');
    }
    await expect(confirmation).toHaveCount(0);
    await expect(page).toHaveURL(/\/partner\/new$/);
    await expect(page.getByRole('heading', { name: 'New Request', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    expect(
      submissionCalls,
      'Invalid form must not send a request-submission mutation',
    ).toHaveLength(0);
    await field.scrollIntoViewIfNeeded();
    await test.info().attach(scenario, { body: await page.screenshot(), contentType: 'image/png' });
    results.push({
      scenario,
      validation: message ?? (await field.getAttribute('aria-invalid')),
      stayedOnForm: true,
      submissionCalls: submissionCalls.length,
    });
  }

  await test.step('Missing CT blocks an otherwise complete form', async () => {
    await prepareHospitalReworkRequest(page, `${code}-no-ct`, null);

    await attemptSubmission(
      page.getByRole('group', { name: 'CT file', exact: true }),
      'missing-ct',
    );
  });

  await test.step('Empty planned surgery date blocks a form with a synthetic CT attached', async () => {
    const ct = { ...syntheticCtRoundTwo, name: `${code}-ct.zip` };
    await prepareHospitalReworkRequest(page, `${code}-no-surgery`, ct);
    const surgeryDate = page.getByRole('textbox', { name: /^Planned surgery date\*/ });
    const originalDate = await surgeryDate.inputValue();
    await surgeryDate.fill('');
    await expect(page.getByText(ct.name, { exact: true }).first()).toBeVisible();
    await attemptSubmission(surgeryDate, 'missing-surgery-date', 'Surgery date is required.');
    await surgeryDate.fill(originalDate);
    await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
    const confirmation = page.getByRole('alertdialog', {
      name: 'Submit this request?',
      exact: true,
    });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Continue editing', exact: true }).click();
    expect(submissionCalls).toHaveLength(0);
  });

  await test.info().attach('required-submission-results', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });
  console.log(JSON.stringify({ results, result: 'PASSED' }));
});
