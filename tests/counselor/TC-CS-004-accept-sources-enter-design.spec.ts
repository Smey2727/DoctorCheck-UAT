import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';
import { createHospitalReworkRequest } from '../helpers/requests';
import { syntheticCtRoundTwo } from '../helpers/synthetic-ct';

function currentStatus(page: Page, requestId: string, status: string) {
  return page.getByRole('heading', { name: requestId, exact: true }).locator('..')
    .getByRole('button', { name: status, exact: true });
}

async function startReview(page: Page, requestId: string, note: string) {
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Optional note for the status history', exact: true });
  await input.fill(note);
  await input.locator('..').getByRole('button', { name: 'Start review', exact: true }).click();
  await expect(input).toBeHidden();
  await expect(currentStatus(page, requestId, 'In review')).toBeVisible();
}

// TC-CS-004: Accepting sources saves a decision, but only Enter Design Stage
// transitions IN_REVIEW to CONVERTING_3D. Each run creates its own two-round case.
test('TC-CS-004: Counselor can accept Round 2 sources and enter the design stage', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const caseCode = `TC-CS-004-${randomUUID().slice(0, 8)}`;
    const submissionPage = await hospitalContext.newPage();
    await signIn(submissionPage, USERS.hospital);
    const requestId = await createHospitalReworkRequest(submissionPage, caseCode);
    test.info().annotations.push({ type: 'request', description: requestId });
    await submissionPage.close();

    await test.step('Prepare an initial review and request a corrected CT submission', async () => {
      await signIn(page, USERS.counselor);
      await page.goto('/counselor/requests');
      await page.getByRole('searchbox', { name: /^Search request no\./ }).fill(requestId);
      const row = page.getByRole('row').filter({
        has: page.getByRole('cell', { name: requestId, exact: true }),
      });
      await expect(row.getByRole('cell', { name: 'Submitted', exact: true })).toBeVisible();
      const claim = row.getByRole('button', { name: 'Claim', exact: true });
      await claim.click();
      await expect(claim).toBeHidden();
      await row.getByRole('link', { name: 'Open', exact: true }).click();
      await startReview(page, requestId, `${caseCode}: review Round 1`);
      await page.getByRole('button', { name: 'Request rework', exact: true }).click();
      await page.getByRole('textbox', { name: 'Explain what the partner needs to fix', exact: true })
        .fill(`${caseCode}: Replace the placeholder with the synthetic CT test series.`);
      await page.getByRole('button', { name: 'Send rework request', exact: true }).click();
      await expect(currentStatus(page, requestId, 'Rework requested')).toBeVisible();
    });

    await test.step('Hospital resubmits readable synthetic CT files as Round 2', async () => {
      const hospitalPage = await hospitalContext.newPage();
      await hospitalPage.goto(`/partner/requests/${requestId}`);
      await hospitalPage.getByRole('link', { name: 'Fix & resubmit', exact: true }).click();
      await hospitalPage.getByRole('textbox', { name: 'Case description', exact: true })
        .fill(`${caseCode}: Synthetic CT verification test. No patient data; not for clinical use.`);
      await hospitalPage.locator('input[type="file"][accept*=".dcm"]').setInputFiles(syntheticCtRoundTwo);
      await expect(hospitalPage.getByText(syntheticCtRoundTwo.name, { exact: true }).first()).toBeVisible();
      await hospitalPage.getByRole('button', { name: 'Resubmit request', exact: true }).first().click();
      const confirmation = hospitalPage.getByRole('alertdialog');
      await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
      await confirmation.getByRole('button', { name: 'Resubmit request', exact: true }).click();
      await expect(hospitalPage).toHaveURL(new RegExp(`/partner/requests/${requestId}$`));
      await expect(currentStatus(hospitalPage, requestId, 'Submitted')).toBeVisible();
      await hospitalPage.close();
    });

    await page.goto(`/counselor/requests/${requestId}`);
    await startReview(page, requestId, `${caseCode}: review Round 2`);
    await page.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
    const roundTwo = page.getByRole('heading', { name: 'Round 2', exact: true })
      .locator('xpath=ancestor::section[1]');
    await expect(roundTwo.getByText(syntheticCtRoundTwo.name, { exact: true })).toBeVisible();

    await test.step('Accept latest round without changing In review', async () => {
      const accept = page.getByRole('button', { name: 'Accept latest round', exact: true });
      // Verification completes on the server, but this view does not poll it.
      // Refresh read-only state until the actual acceptance gate becomes enabled.
      await expect(async () => {
        await page.reload();
        await page.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
        await expect(accept).toBeEnabled({ timeout: 1_000 });
      }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
      const [acceptedResponse] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/graphql')
          && response.request().postDataJSON()?.operationName === 'AcceptRequestSource'),
        accept.click(),
      ]);
      expect(acceptedResponse.ok()).toBeTruthy();
      const acceptedBody = await acceptedResponse.json();
      expect(acceptedBody.errors).toBeUndefined();
      const history = acceptedBody.data.acceptRequestSource;
      const latestRound = history.rounds.find((round: { roundNumber: number }) => round.roundNumber === 2);
      expect(latestRound).toBeDefined();
      const currentDecisions = history.acceptances.filter((decision: { current: boolean }) => decision.current);
      expect(currentDecisions).toHaveLength(1);
      const decision = currentDecisions[0];
      expect(decision.basisSubmissionRoundId).toBe(latestRound.id);
      expect(decision.attachments).toHaveLength(1);
      expect(decision.attachments[0].file.originalName).toBe(syntheticCtRoundTwo.name);
      const decisionCard = page.getByRole('article').filter({ hasText: syntheticCtRoundTwo.name });
      await expect(decisionCard).toHaveCount(1);
      await expect(decisionCard.getByText('CT · v2', { exact: true })).toBeVisible();
      await expect(currentStatus(page, requestId, 'In review')).toBeVisible();

      // Reload to prove the server saved the same decision, not just a UI update.
      const [persistedResponse] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/graphql')
          && response.request().postData()?.includes('requestSourceHistory') === true),
        page.reload(),
      ]);
      const persistedBody = await persistedResponse.json();
      expect(persistedBody.errors).toBeUndefined();
      expect(persistedBody.data.requestSourceHistory.acceptances).toEqual(
        expect.arrayContaining([expect.objectContaining({
          id: decision.id,
          current: true,
          basisSubmissionRoundId: latestRound.id,
          attachments: expect.arrayContaining([expect.objectContaining({ id: decision.attachments[0].id })]),
        })]),
      );
      await expect(currentStatus(page, requestId, 'In review')).toBeVisible();
      await page.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
      await expect(decisionCard).toHaveCount(1);
    });
    await test.step('Enter design stage and verify Converting 3D', async () => {
      const [response] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/graphql')
          && response.request().postDataJSON()?.operationName === 'EnterDesignStage'),
        page.getByRole('button', { name: /^Enter design stage$/i }).click(),
      ]);
      expect(response.ok()).toBeTruthy();
      const body = await response.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.enterDesignStage).toMatchObject({ requestNo: requestId, status: 'CONVERTING_3D' });
      await expect(currentStatus(page, requestId, 'Converting 3D')).toBeVisible();
      await page.reload();
      await expect(currentStatus(page, requestId, 'Converting 3D')).toBeVisible();
    });
  } finally {
    await hospitalContext.close();
  }
});
