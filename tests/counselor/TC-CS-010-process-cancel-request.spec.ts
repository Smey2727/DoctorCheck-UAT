import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';
import { createHospitalReworkRequest } from '../helpers/requests';
import { syntheticCtRoundTwo } from '../helpers/synthetic-ct';
import { syntheticModel } from '../helpers/synthetic-model';

function status(page: Page, requestId: string, name: string) {
  return page.getByRole('heading', { name: requestId, exact: true }).locator('..')
    .getByRole('button', { name, exact: true });
}

async function loadRequest(page: Page, requestId: string, model = false) {
  const [response] = await Promise.all([
    page.waitForResponse(async response => {
      if (!response.url().endsWith('/graphql')) return false;
      const body = await response.json().catch(() => null);
      return body?.data?.request?.details?.requestNo === requestId;
    }),
    page.goto(model ? `/requests/${requestId}/model` : `/counselor/requests/${requestId}`),
  ]);
  return (await response.json()).data.request;
}

// TC-CS-010: Cancellation must pass through CANCEL_REQUESTED before CANCELLED.
test('TC-CS-010: Counselor processes a cancellation request before cancelling', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-CS-010-${randomUUID().slice(0, 8)}`;
    await signIn(hospitalPage, USERS.hospital);
    const requestId = await createHospitalReworkRequest(hospitalPage, caseCode, {
      ...syntheticCtRoundTwo, name: `${caseCode}-ct.zip`,
    });
    test.info().annotations.push({ type: 'request', description: requestId });
    await hospitalPage.close();
    const counselor = await signIn(page, USERS.counselor);
    await test.step('Prepare a fresh request and accept its sources', async () => {
      await page.goto('/counselor/requests');
      await page.getByRole('searchbox', { name: /^Search request no\./ }).fill(requestId);
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: requestId, exact: true }) });
      const claim = row.getByRole('button', { name: 'Claim', exact: true });
      await claim.click();
      await expect(claim).toBeHidden();
      await page.goto(`/counselor/requests/${requestId}`);
      await page.getByRole('button', { name: 'Start review', exact: true }).click();
      const note = page.getByRole('textbox', { name: 'Optional note for the status history', exact: true });
      await note.fill(`${caseCode}: source review`);
      await note.locator('..').getByRole('button', { name: 'Start review', exact: true }).click();
      await expect(status(page, requestId, 'In review')).toBeVisible();
      await expect(async () => {
        await page.reload();
        await page.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
        await expect(page.getByRole('button', { name: 'Accept latest round', exact: true }))
          .toBeEnabled({ timeout: 1_000 });
      }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
      await page.getByRole('button', { name: 'Accept latest round', exact: true }).click();
      await page.getByRole('button', { name: /^Enter design stage$/i }).click();
      await expect(status(page, requestId, 'Converting 3D')).toBeVisible();
    });
    await test.step('Register converted model', async () => {
      await loadRequest(page, requestId, true);
      const upload = page.getByRole('button', { name: 'Upload converted 3D', exact: true });
      await expect(upload).toBeVisible();
      const fileChooser = page.waitForEvent('filechooser');
      await upload.click();
      const [response] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/graphql')
          && response.request().postDataJSON()?.operationName === 'RegisterDesignFile'),
        (await fileChooser).setFiles(syntheticModel(`${caseCode}-converted.stl`)),
      ]);
      const body = await response.json();
      expect(body.errors).toBeUndefined();
      await expect(async () => {
        const request = await loadRequest(page, requestId, true);
        expect(request.details.allowedActions).toContain('REGISTER_DESIGN_FILE');
        await expect(page.getByRole('button', { name: 'Upload design result', exact: true })).toBeVisible();
      }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
    });
    await test.step('Register Design Result v1', async () => {
      await page.getByRole('button', { name: 'Upload design result', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Upload design result', exact: true });
      await dialog.getByRole('spinbutton', { name: 'Width (mm)*', exact: true }).fill('10');
      await dialog.getByRole('spinbutton', { name: 'Height (mm)*', exact: true }).fill('10');
      await dialog.getByRole('spinbutton', { name: 'Thickness (mm)*', exact: true }).fill('10');
      const designName = `${caseCode}-design.stl`;
      await dialog.locator('input[type="file"]').setInputFiles(syntheticModel(designName));
      const [response] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/graphql')
          && response.request().postDataJSON()?.operationName === 'RegisterDesignFile'),
        dialog.getByRole('button', { name: 'Upload design result', exact: true }).click(),
      ]);
      const body = await response.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.registerDesignFile).toMatchObject({ requestNo: requestId, status: 'PRODUCT_DESIGN' });
      await expect(dialog).toBeHidden();
    });
    const reason = `${caseCode}: Synthetic partner cancellation request; no real phone call.`;
    const note = `${caseCode}: UAT cancellation handling only.`;
    let requestedAt: string;
    await test.step('Log cancellation at Product design without closing the request', async () => {
      const initial = await loadRequest(page, requestId);
      expect(initial.details.status).toBe('PRODUCT_DESIGN');
      await expect(status(page, requestId, 'Product design')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Complete cancellation', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Log phone cancellation', exact: true }).click();
      await page.getByRole('textbox', { name: 'Reason the partner phoned in the cancellation', exact: true }).fill(reason);
      await page.getByRole('textbox', { name: 'Optional handling note', exact: true }).fill(note);
      await page.getByRole('button', { name: 'Review cancellation', exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: 'Log this phone cancellation?', exact: true });
      await expect(confirmation).toContainText(reason);
      await confirmation.getByRole('button', { name: 'Log phone cancellation', exact: true }).click();
      await expect(confirmation).toBeHidden();
      await expect(status(page, requestId, 'Cancellation requested')).toBeVisible();
      const requested = await loadRequest(page, requestId);
      expect(requested.details.status).toBe('CANCEL_REQUESTED');
      expect(requested.details.cancelledAt).toBeNull();
      expect(requested.details.cancelRequestedAt).toBeTruthy();
      requestedAt = requested.details.cancelRequestedAt;
      await expect(page.getByRole('definition').filter({ hasText: reason })).toHaveText(reason);
      await expect(page.getByRole('definition').filter({ hasText: note })).toHaveText(note);
      await expect(page.getByRole('button', { name: 'Complete cancellation', exact: true })).toBeEnabled();
    });
    await test.step('Complete cancellation only after confirming handling', async () => {
      await page.getByRole('button', { name: 'Complete cancellation', exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: 'Complete this cancellation?', exact: true });
      const finish = confirmation.getByRole('button', { name: 'Complete cancellation', exact: true });
      await expect(finish).toBeDisabled();
      await confirmation.getByRole('checkbox', { name: /^I confirm the cancellation request/ }).check();
      await finish.click();
      await expect(confirmation).toBeHidden();
      await expect(status(page, requestId, 'Cancelled')).toBeVisible();
    });
    await test.step('Persist the ordered transitions and cancellation audit', async () => {
      const finalPage = await page.context().newPage();
      try {
        const cancelled = await loadRequest(finalPage, requestId);
        expect(cancelled.details.status).toBe('CANCELLED');
        expect(cancelled.details.cancelRequestedAt).toBe(requestedAt);
        expect(cancelled.details.cancelledAt).toBeTruthy();
        expect(Date.parse(cancelled.details.cancelledAt)).toBeGreaterThanOrEqual(Date.parse(requestedAt));
        expect(cancelled.cancellationHandlerUserId).toBe(counselor.id);
        expect(cancelled.details.cancellationHandlerName).toBe(counselor.displayName);
        expect(cancelled.details.statusHistory.map((event: { status: string }) => event.status).slice(-3))
          .toEqual(['PRODUCT_DESIGN', 'CANCEL_REQUESTED', 'CANCELLED']);
        await expect(status(finalPage, requestId, 'Cancelled')).toBeVisible();
        await expect(finalPage.getByRole('definition').filter({ hasText: reason })).toHaveText(reason);
        await expect(finalPage.getByRole('button', { name: 'Complete cancellation', exact: true })).toHaveCount(0);
        await expect(finalPage.getByRole('button', { name: 'Log phone cancellation', exact: true })).toHaveCount(0);
      } finally { await finalPage.close(); }
    });
  } finally { await hospitalContext.close(); }
});
