import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';
import { createHospitalReworkRequest } from '../helpers/requests';

// TC-CS-014: Request rework. A fresh hospital request must transition to
// Rework requested (SUPPLEMENT_REQUESTED), and its owner must receive the reason.
test('TC-CS-014: Hospital sees the exact rework reason on the request and notification', async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000);
  // Keep the hospital and counselor sessions isolated.
  const hospitalContext = await browser.newContext({ baseURL });
  const hospitalPage = await hospitalContext.newPage();
  try {
    const caseCode = `TC-CS-014-${randomUUID().slice(0, 8)}`;
    await signIn(hospitalPage, USERS.hospital);
    const requestId = await createHospitalReworkRequest(hospitalPage, caseCode);
    const reason = 'CT slice too thick';
    test.info().annotations.push({ type: 'request', description: requestId });

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
    await page.goto(`/counselor/requests/${requestId}`);

    const heading = page.getByRole('heading', { name: requestId, exact: true });
    await expect(heading).toBeVisible();
    const header = heading.locator('..');
    await page.getByRole('button', { name: 'Start review', exact: true }).click();
    const statusNote = page.getByRole('textbox', { name: 'Optional note for the status history', exact: true });
    await statusNote.fill(`Reviewing ${caseCode}`);
    await statusNote.locator('..').getByRole('button', { name: 'Start review', exact: true }).click();
    await expect(header.getByRole('button', { name: 'In review', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Request rework', exact: true }).click();
    const reasonInput = page.getByRole('textbox', { name: 'Explain what the partner needs to fix', exact: true });
    await reasonInput.fill(reason);
    await page.getByRole('button', { name: 'Send rework request', exact: true }).click();
    await expect(reasonInput).toBeHidden();
    await expect(header.getByRole('button', { name: 'Rework requested', exact: true })).toBeVisible();

    await hospitalPage.close();
    const partnerPage = await hospitalContext.newPage();
    await partnerPage.goto(`/partner/requests/${requestId}`);
    await expect(partnerPage.getByRole('heading', { name: requestId, exact: true })).toBeVisible();
    await expect(partnerPage.getByText(reason, { exact: true })).toBeVisible();
    await partnerPage.reload();
    await expect(partnerPage.getByText(reason, { exact: true })).toBeVisible();
    await partnerPage.goto('/notifications');
    const notification = partnerPage.getByRole('article').filter({
      has: partnerPage.getByRole('heading', { name: `Supplement requested for ${requestId}`, exact: true }),
    });
    await expect(notification).toHaveCount(1);
    await expect(notification.getByText(reason, { exact: true })).toBeVisible();
    await expect(notification.getByRole('button', { name: 'Update and resubmit', exact: true })).toBeVisible();
  } finally {
    await hospitalContext.close();
  }
});
