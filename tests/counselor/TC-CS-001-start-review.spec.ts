import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn, signOut, USERS } from '../helpers/auth';
import { createHospitalReworkRequest } from '../helpers/requests';

// TC-CS-001: Start review
// Open queue, click Start Review
// Expected: request listed; status IN_REVIEW

test('TC-CS-001: Counselor can claim a request and start review', async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000);
  // Each run owns its request, so earlier runs cannot exhaust the available queue.
  const requestId = await test.step('Create a fresh unassigned hospital request', async () => {
    const hospitalContext = await browser.newContext({ baseURL });
    try {
      const hospitalPage = await hospitalContext.newPage();
      await signIn(hospitalPage, USERS.hospital);
      return await createHospitalReworkRequest(hospitalPage, `TC-CS-001-${randomUUID().slice(0, 8)}`);
    } finally {
      await hospitalContext.close();
    }
  });
  test.info().annotations.push({ type: 'request', description: requestId });

  // Sign in as Counselor
  await signIn(page, USERS.counselor);

  // Open the full queue and locate only this run's request.
  await page.goto('/counselor/requests');
  await page.getByRole('searchbox', { name: /^Search request no\./ }).fill(requestId);

  // Only Submitted requests can start review.
  await page.getByRole('combobox', { name: 'Status', exact: true })
    .selectOption({ label: 'Submitted' });

  const requestRow = page.getByRole('row').filter({
    has: page.getByRole('cell', { name: requestId, exact: true }),
  });
  await expect(requestRow.getByRole('cell', { name: 'Submitted', exact: true })).toBeVisible();
  await expect(requestRow.getByRole('cell', { name: 'Unassigned', exact: true })).toBeVisible();
  const claimButton = requestRow.getByRole('button', { name: 'Claim', exact: true });
  await claimButton.click();
  await expect(claimButton).toBeHidden();
  await requestRow.getByRole('link', { name: 'Open', exact: true }).click();

  const requestHeading = page.getByRole('heading', { name: requestId, exact: true });
  await expect(requestHeading).toBeVisible();
  // The current status shares the heading's parent; the state-flow list is separate.
  const requestHeader = requestHeading.locator('..');
  await expect(requestHeader.getByRole('button', { name: 'Submitted', exact: true }))
    .toBeVisible();

  // Click "Start review" to open the inline confirmation panel.
  await page.getByRole('button', { name: 'Start review', exact: true }).click();

  // Enter a note for the status change
  const statusNote = page.getByRole('textbox', {
    name: 'Optional note for the status history', exact: true,
  });
  await statusNote.fill('ok');
  const confirmationPanel = statusNote.locator('..');

  // Scope confirmation to the note's panel, avoiding the page-level action.
  await confirmationPanel.getByRole('button', { name: 'Start review', exact: true }).click();
  await expect(statusNote).toBeHidden();

  // Verify the status changed to In review
  await expect(requestHeader.getByRole('button', { name: 'In review', exact: true }))
    .toBeVisible();

  // Sign out
  await signOut(page);
});
