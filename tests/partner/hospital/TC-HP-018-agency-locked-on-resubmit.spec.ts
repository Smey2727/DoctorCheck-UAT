import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';
import { createHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

async function loadRequest(page: Page, requestId: string, role: 'partner' | 'counselor') {
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    page.goto(`/${role}/requests/${requestId}`),
  ]);
  expect(body.errors).toBeUndefined();
  expect(body.data.request.details.requestNo).toBe(requestId);
  return body.data.request.details;
}

function status(page: Page, requestId: string, label: string) {
  return page.getByRole('heading', { name: requestId, exact: true }).locator('..')
    .getByRole('button', { name: label, exact: true });
}

test('TC-HP-018: Billing agency is locked during rework and preserved after resubmission', async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  const counselorContext = await browser.newContext({ baseURL });
  counselorContext.setDefaultTimeout(15_000);
  try {
    await signIn(page, 'hospital.b@saerosoft.com');
    await page.goto('/partner/new');
    const selector = page.getByRole('combobox', { name: /^Financial agency\*/ });
    await expect(selector.locator('option[value]:not([value=""])')).toHaveCount(2);
    const agencyId = (await selector.getByRole('option', { name: 'Agency B Distribution', exact: true }).getAttribute('value'))!;
    const alternativeId = (await selector.getByRole('option', { name: 'Agency A Distribution', exact: true }).getAttribute('value'))!;
    expect(agencyId).toBeTruthy();
    expect(alternativeId).toBeTruthy();
    expect(alternativeId).not.toBe(agencyId);
    const code = `TC-HP-018-${randomUUID().slice(0, 8)}`;
    const requestId = await createHospitalReworkRequest(page, code,
      { ...syntheticCtRoundTwo, name: `${code}-ct.zip` }, agencyId, 'PEEK');
    test.info().annotations.push({ type: 'request', description: requestId });
    const original = await loadRequest(page, requestId, 'partner');
    expect(original).toMatchObject({ status: 'SUBMITTED', financialAgencyUserId: agencyId });
    const billing = page.getByRole('term').filter({ hasText: /^Billing account$/ })
      .locator('xpath=following-sibling::dd[1]');
    await expect(billing).toContainText('Agency B Distribution');
    const originalBillingText = await billing.innerText();
    const counselor = await counselorContext.newPage();
    await signIn(counselor, USERS.counselor);

    await test.step('Counselor requests rework on the submitted agency-billed request', async () => {
      await counselor.goto('/counselor/requests');
      await counselor.getByRole('searchbox', { name: /^Search request no\./ }).fill(requestId);
      const row = counselor.getByRole('row').filter({ has: counselor.getByRole('cell', { name: requestId, exact: true }) });
      await row.getByRole('button', { name: 'Claim', exact: true }).click();
      await expect(row.getByRole('button', { name: 'Claim', exact: true })).toBeHidden();
      await counselor.goto(`/counselor/requests/${requestId}`);
      await counselor.getByRole('button', { name: 'Start review', exact: true }).click();
      const note = counselor.getByRole('textbox', { name: 'Optional note for the status history', exact: true });
      await note.fill(`${code}: Synthetic source review.`);
      await note.locator('..').getByRole('button', { name: 'Start review', exact: true }).click();
      await expect(status(counselor, requestId, 'In review')).toBeVisible();
      await counselor.getByRole('button', { name: 'Request rework', exact: true }).click();
      await counselor.getByRole('textbox', { name: 'Explain what the partner needs to fix', exact: true })
        .fill(`${code}: Clarify the case description; retain the readable synthetic CT.`);
      await counselor.getByRole('button', { name: 'Send rework request', exact: true }).click();
      await expect(status(counselor, requestId, 'Rework requested')).toBeVisible();
    });

    await test.step('Hospital cannot change billing agency despite having another active connection', async () => {
      const rework = await loadRequest(page, requestId, 'partner');
      expect(rework).toMatchObject({ status: 'SUPPLEMENT_REQUESTED', financialAgencyUserId: agencyId });
      await page.getByRole('link', { name: 'Fix & resubmit', exact: true }).click();
      const fixedAgency = page.getByRole('status', { name: 'Financial agency', exact: true });
      await expect(fixedAgency).toContainText('Agency B Distribution');
      await expect(page.getByRole('combobox', { name: /Financial agency|Billing account/i })).toHaveCount(0);
      await expect(page.getByText('Fixed for this request after first submission.', { exact: true }).first()).toBeVisible();
      await page.reload();
      await expect(fixedAgency).toContainText('Agency B Distribution');
      await expect(page.getByRole('combobox', { name: /Financial agency|Billing account/i })).toHaveCount(0);
      await test.info().attach('billing-agency-locked', { body: await page.screenshot(), contentType: 'image/png' });
      await page.getByRole('textbox', { name: 'Case description', exact: true })
        .fill(`${code}: Clarified synthetic case details. Billing agency remains unchanged.`);
    });

    await test.step('Resubmission succeeds and retains the original agency in both roles', async () => {
      await page.getByRole('button', { name: 'Resubmit request', exact: true }).first().click();
      const confirmation = page.getByRole('alertdialog');
      await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
      const [body] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql')
          && /mutation/.test(r.request().postDataJSON()?.query ?? '')).then(r => r.json()),
        confirmation.getByRole('button', { name: 'Resubmit request', exact: true }).click(),
      ]);
      expect(body.errors).toBeUndefined();
      await expect(page).toHaveURL(new RegExp(`/partner/requests/${requestId}$`));
      const persisted = await loadRequest(page, requestId, 'partner');
      expect(persisted).toMatchObject({ status: 'SUBMITTED', financialAgencyUserId: agencyId });
      await expect(status(page, requestId, 'Submitted')).toBeVisible();
      await expect(billing).toHaveText(originalBillingText);
      const reviewed = await loadRequest(counselor, requestId, 'counselor');
      expect(reviewed).toMatchObject({ status: 'SUBMITTED', financialAgencyUserId: agencyId });
      expect(reviewed.statusHistory.map((e: { status: string }) => e.status).slice(-2))
        .toEqual(['SUPPLEMENT_REQUESTED', 'SUBMITTED']);
      await test.info().attach('resubmitted-same-billing-agency', { body: await page.screenshot(), contentType: 'image/png' });
      const result = { requestId, agency: 'Agency B Distribution', agencyId, alternativeAgencyAvailableForNewRequests: true,
        agencyLockedOnResubmit: true, lockMessage: 'Fixed for this request after first submission.',
        finalStatus: 'SUBMITTED', persistedAgencyUnchanged: true };
      await test.info().attach('agency-lock-results', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
      console.log(JSON.stringify(result));
    });
  } finally {
    await counselorContext.close();
  }
});
