import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';
import { createHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

function header(page: Page, requestId: string) {
  return page.getByRole('heading', { name: requestId, exact: true }).locator('..');
}

function round(page: Page, number: number) {
  return page.getByRole('heading', { name: `Round ${number}`, exact: true })
    .locator('xpath=ancestor::section[1]');
}

test('TC-HP-008: Rework resubmission creates Round 2 and preserves Round 1', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const counselorContext = await browser.newContext({ baseURL });
  const counselor = await counselorContext.newPage();
  counselor.setDefaultTimeout(15_000);
  try {
    const code = `TC-HP-008-${randomUUID().slice(0, 8)}`;
    await signIn(page, USERS.hospital);
    // Round 1 deliberately has an incomplete synthetic CT ZIP to justify rework.
    const requestId = await createHospitalReworkRequest(page, code);
    test.info().annotations.push({ type: 'request', description: requestId });

    await test.step('Counselor reviews the request and requests a replacement CT', async () => {
      await signIn(counselor, USERS.counselor);
      await counselor.goto('/counselor/requests');
      await counselor.getByRole('searchbox', { name: /^Search request no\./ }).fill(requestId);
      const row = counselor.getByRole('row').filter({
        has: counselor.getByRole('cell', { name: requestId, exact: true }),
      });
      await row.getByRole('button', { name: 'Claim', exact: true }).click();
      await expect(row.getByRole('button', { name: 'Claim', exact: true })).toBeHidden();
      await row.getByRole('link', { name: 'Open', exact: true }).click();
      await counselor.getByRole('button', { name: 'Start review', exact: true }).click();
      const note = counselor.getByRole('textbox', { name: 'Optional note for the status history', exact: true });
      await note.fill(`${code}: Review original CT upload.`);
      await note.locator('..').getByRole('button', { name: 'Start review', exact: true }).click();
      await expect(header(counselor, requestId).getByRole('button', { name: 'In review', exact: true })).toBeVisible();
      await counselor.getByRole('button', { name: 'Request rework', exact: true }).click();
      await counselor.getByRole('textbox', { name: 'Explain what the partner needs to fix', exact: true })
        .fill(`${code}: Replace incomplete CT ZIP with the readable synthetic CT fixture.`);
      await counselor.getByRole('button', { name: 'Send rework request', exact: true }).click();
      await expect(header(counselor, requestId).getByRole('button', { name: 'Rework requested', exact: true })).toBeVisible();
    });

    await counselor.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
    const originalRound = round(counselor, 1);
    await expect(originalRound.getByRole('listitem')).toHaveCount(1);
    await expect(originalRound.getByText('rework-ct-placeholder.zip', { exact: true })).toBeVisible();
    const originalSubmission = await originalRound.getByRole('paragraph').innerText();
    const originalFiles = await originalRound.getByRole('list').ariaSnapshot();
    const replacement = { ...syntheticCtRoundTwo, name: `${code}-round-2-ct.zip` };

    await test.step('Hospital replaces the CT file at SUPPLEMENT_REQUESTED and resubmits', async () => {
      await page.reload();
      await expect(header(page, requestId).getByRole('button', { name: 'Rework requested', exact: true })).toBeVisible();
      await page.getByRole('link', { name: 'Fix & resubmit', exact: true }).click();
      await page.locator('input[type="file"][accept*=".dcm"]').setInputFiles(replacement);
      await expect(page.getByText(replacement.name, { exact: true }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Resubmit request', exact: true }).first().click();
      const confirmation = page.getByRole('alertdialog');
      await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
      await confirmation.getByRole('button', { name: 'Resubmit request', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/partner/requests/${requestId}$`));
      await page.reload();
      await expect(header(page, requestId).getByRole('button', { name: 'Submitted', exact: true })).toBeVisible();
      await test.info().attach('hospital-resubmitted', { body: await page.screenshot(), contentType: 'image/png' });
    });

    await test.step('Persisted history has a new round and the original round is unchanged', async () => {
      await counselor.reload();
      await expect(header(counselor, requestId).getByRole('button', { name: 'Submitted', exact: true })).toBeVisible();
      await counselor.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
      await expect(counselor.getByRole('heading', { name: /^Round \d+$/, level: 3 })).toHaveCount(2);
      const newRound = round(counselor, 2);
      await expect(newRound.getByText('Latest round', { exact: true })).toBeVisible();
      await expect(newRound.getByRole('listitem')).toHaveCount(1);
      await expect(newRound.getByText(replacement.name, { exact: true })).toBeVisible();
      await expect(newRound.getByText('CT · v2', { exact: true })).toBeVisible();
      await expect(newRound.getByText('rework-ct-placeholder.zip', { exact: true })).toHaveCount(0);
      await expect(originalRound.getByRole('paragraph')).toHaveText(originalSubmission);
      await expect(originalRound.getByRole('list')).toMatchAriaSnapshot(originalFiles);
      await expect(originalRound.getByText(replacement.name, { exact: true })).toHaveCount(0);
      await expect(originalRound.getByText('Latest round', { exact: true })).toHaveCount(0);
      await test.info().attach('preserved-submission-rounds', { body: await counselor.screenshot(), contentType: 'image/png' });
      await test.info().attach('round-evidence', {
        body: JSON.stringify({ requestId, status: 'SUBMITTED', rounds: 2, originalSubmission,
          originalFiles, replacementFile: replacement.name, originalRoundUnchanged: true }, null, 2),
        contentType: 'application/json',
      });
      console.log(JSON.stringify({ requestId, status: 'SUBMITTED', rounds: 2, originalRoundUnchanged: true }));
    });
  } finally {
    await counselorContext.close();
  }
});
