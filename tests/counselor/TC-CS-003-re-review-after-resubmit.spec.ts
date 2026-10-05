import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';
import { createHospitalReworkRequest } from '../helpers/requests';

// A valid ZIP with a synthetic ROUND-2.txt, deliberately different from Round 1.
// Tests submission history only; neither fixture contains clinical images.
const roundTwoFile = {
  name: 'tc-cs-003-round-2.zip',
  mimeType: 'application/zip',
  buffer: Buffer.from(
    'UEsDBBQAAAAIAAAAIVzsrsuXdwAAAJMAAAALAAAAUk9VTkQtMi50eHQtykEOwjAMBdGr/APQqMARyppNkVinqVMsUhs5jqC3p0gsR/PGTfxBzgm3oRvGru/PMKptWrlWVkHmjzejA0ybzDgFXDhnMhLfXyEkFd+jIpuuf3UMuCpe0fnH5ugRakiFhVMs4DUuVAPuas9c9A2n6iwLVMoWvlBLAQIUABQAAAAIAAAAIVzsrsuXdwAAAJMAAAALAAAAAAAAAAAAAAAAAAAAAABST1VORC0yLnR4dFBLBQYAAAAAAQABADkAAACgAAAAAAA=',
    'base64',
  ),
};

function requestHeader(page: Page, requestId: string) {
  return page.getByRole('heading', { name: requestId, exact: true }).locator('..');
}

function submissionRound(page: Page, round: number) {
  // The enclosing workbench is also a section; use the heading's nearest section.
  return page.getByRole('heading', { name: `Round ${round}`, exact: true })
    .locator('xpath=ancestor::section[1]');
}

function billingAccount(page: Page) {
  return page.getByRole('term').filter({ hasText: /^Billing account$/ })
    .locator('..').getByRole('definition');
}

async function startReview(page: Page, requestId: string, note: string) {
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  const statusNote = page.getByRole('textbox', {
    name: 'Optional note for the status history', exact: true,
  });
  await statusNote.fill(note);
  await statusNote.locator('..').getByRole('button', { name: 'Start review', exact: true }).click();
  await expect(statusNote).toBeHidden();
  await expect(requestHeader(page, requestId).getByRole('button', {
    name: 'In review', exact: true,
  })).toBeVisible();
}

// TC-CS-003: Resubmission creates a new review round while preserving old records.
// Uses a fresh hospital-owned case; does not depend on TC-CS-001 or TC-CS-002.
test('TC-CS-003: Counselor can re-review a resubmission while preserving Round 1 and billing', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const caseCode = `TC-CS-003-${randomUUID().slice(0, 8)}`;
    const submissionPage = await hospitalContext.newPage();
    await signIn(submissionPage, USERS.hospital);
    const requestId = await createHospitalReworkRequest(submissionPage, caseCode);
    test.info().annotations.push({ type: 'request', description: requestId });
    await expect(billingAccount(submissionPage)).toHaveText('Direct partner billing');
    const originalBilling = await billingAccount(submissionPage).innerText();
    // Keep the authenticated context, but do not reuse pages across role changes.
    await submissionPage.close();

    await test.step('Claim the fresh Submitted request and start Round 1 review', async () => {
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
    });

    await test.step('Request corrections from the hospital', async () => {
      await page.getByRole('button', { name: 'Request rework', exact: true }).click();
      await page.getByRole('textbox', { name: 'Explain what the partner needs to fix', exact: true })
        .fill(`${caseCode}: Replace the CT placeholder and update the case description.`);
      await page.getByRole('button', { name: 'Send rework request', exact: true }).click();
      await expect(requestHeader(page, requestId).getByRole('button', {
        name: 'Rework requested', exact: true,
      })).toBeVisible();
    });

    await page.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
    const roundOne = submissionRound(page, 1);
    await expect(roundOne.getByRole('listitem')).toHaveCount(1);
    await expect(roundOne.getByText('rework-ct-placeholder.zip', { exact: true })).toBeVisible();
    // Exclude the "Latest round" badge, which correctly moves to Round 2.
    const originalSubmission = await roundOne.getByRole('paragraph').innerText();
    const originalFiles = await roundOne.getByRole('list').ariaSnapshot();

    await test.step('Hospital replaces the file and resubmits with billing fixed', async () => {
      const hospitalPage = await hospitalContext.newPage();
      await hospitalPage.goto(`/partner/requests/${requestId}`);
      await hospitalPage.getByRole('link', { name: 'Fix & resubmit', exact: true }).click();
      const agency = hospitalPage.getByRole('status', { name: 'Financial agency', exact: true });
      await expect(agency).toHaveText(originalBilling);
      await expect(hospitalPage.getByRole('combobox', { name: /Financial agency|Billing account/i })).toHaveCount(0);
      await hospitalPage.getByRole('textbox', { name: 'Case description', exact: true })
        .fill(`${caseCode}: Updated synthetic case details for Round 2. No patient data.`);
      await hospitalPage.locator('input[type="file"][accept*=".dcm"]').setInputFiles(roundTwoFile);
      await expect(hospitalPage.getByText(roundTwoFile.name, { exact: true }).first()).toBeVisible();
      await expect(agency).toHaveText(originalBilling);
      await hospitalPage.getByRole('button', { name: 'Resubmit request', exact: true }).first().click();
      const confirmation = hospitalPage.getByRole('alertdialog');
      await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
      await confirmation.getByRole('button', { name: 'Resubmit request', exact: true }).click();
      await expect(hospitalPage).toHaveURL(new RegExp(`/partner/requests/${requestId}$`));
      await expect(requestHeader(hospitalPage, requestId).getByRole('button', {
        name: 'Submitted', exact: true,
      })).toBeVisible();
      await expect(billingAccount(hospitalPage)).toHaveText(originalBilling);
      await hospitalPage.close();
    });

    await test.step('Counselor finds the resubmission in Submitted and starts review again', async () => {
      await page.goto('/counselor/requests');
      await page.getByRole('searchbox', { name: /^Search request no\./ }).fill(requestId);
      const row = page.getByRole('row').filter({
        has: page.getByRole('cell', { name: requestId, exact: true }),
      });
      await expect(row.getByRole('cell', { name: 'Submitted', exact: true })).toBeVisible();
      await row.getByRole('link', { name: 'Open', exact: true }).click();
      await startReview(page, requestId, `${caseCode}: re-review Round 2`);
    });

    await test.step('Round 2 shows the new file and Round 1 retains its original records', async () => {
      await page.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
      await expect(page.getByRole('heading', { name: /^Round \d+$/, level: 3 })).toHaveCount(2);
      const roundTwo = submissionRound(page, 2);
      await expect(roundTwo.getByText('Latest round', { exact: true })).toBeVisible();
      await expect(roundTwo.getByText(roundTwoFile.name, { exact: true })).toBeVisible();
      await expect(roundTwo.getByText('CT · v2', { exact: true })).toBeVisible();
      await expect(roundTwo.getByText('rework-ct-placeholder.zip', { exact: true })).toHaveCount(0);
      await expect(roundOne.getByRole('paragraph')).toHaveText(originalSubmission);
      await expect(roundOne.getByRole('list')).toMatchAriaSnapshot(originalFiles);
      await expect(roundOne.getByText(roundTwoFile.name, { exact: true })).toHaveCount(0);
      await expect(roundOne.getByText('Latest round', { exact: true })).toHaveCount(0);
      const hospitalPage = await hospitalContext.newPage();
      await hospitalPage.goto(`/partner/requests/${requestId}`);
      await expect(billingAccount(hospitalPage)).toHaveText(originalBilling);
      await hospitalPage.close();
    });
  } finally {
    await hospitalContext.close();
  }
});
