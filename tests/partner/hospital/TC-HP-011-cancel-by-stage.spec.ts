import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';
import { createHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';
import { syntheticModel } from '../../helpers/synthetic-model';

function status(page: Page, requestId: string, label: string) {
  return page.getByRole('heading', { name: requestId, exact: true }).locator('..')
    .getByRole('button', { name: label, exact: true });
}

async function loadRequest(page: Page, requestId: string, role: 'partner' | 'counselor', model = false) {
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    page.goto(model ? `/requests/${requestId}/model` : `/${role}/requests/${requestId}`),
  ]);
  expect(body.errors).toBeUndefined();
  expect(body.data.request.details.requestNo).toBe(requestId);
  return body.data.request.details;
}

async function startReview(page: Page, requestId: string, code: string) {
  await page.goto('/counselor/requests');
  await page.getByRole('searchbox', { name: /^Search request no\./ }).fill(requestId);
  const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: requestId, exact: true }) });
  await row.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(row.getByRole('button', { name: 'Claim', exact: true })).toBeHidden();
  await page.goto(`/counselor/requests/${requestId}`);
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  const note = page.getByRole('textbox', { name: 'Optional note for the status history', exact: true });
  await note.fill(`${code}: Synthetic UAT source review.`);
  await note.locator('..').getByRole('button', { name: 'Start review', exact: true }).click();
  await expect(status(page, requestId, 'In review')).toBeVisible();
}

test('TC-HP-011: Hospital cancellation is immediate during review and unavailable during product design', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const counselorContext = await browser.newContext({ baseURL });
  counselorContext.setDefaultTimeout(15_000);
  try {
    await signIn(page, USERS.hospital);
    const code = `TC-HP-011-${randomUUID().slice(0, 8)}`;
    const requestId = await createHospitalReworkRequest(page, `${code}-review`, {
      ...syntheticCtRoundTwo, name: `${code}-review-ct.zip`,
    });
    test.info().annotations.push({ type: 'request', description: requestId });
    const counselor = await counselorContext.newPage();
    await signIn(counselor, USERS.counselor);
    await startReview(counselor, requestId, code);
    const review = await loadRequest(page, requestId, 'partner');
    expect(review.status).toBe('IN_REVIEW');
    expect(review.allowedActions).toContain('CANCEL_REQUEST');
    await test.step('Hospital directly cancels during IN_REVIEW without a cancellation-request stage', async () => {
      await page.getByRole('button', { name: 'Cancel request', exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: 'Cancel this request?', exact: true });
      await confirmation.getByRole('checkbox', { name: /^I understand that/ }).check();
      const [body] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql')
          && /mutation/.test(r.request().postDataJSON()?.query ?? '')).then(r => r.json()),
        confirmation.getByRole('button', { name: 'Cancel request', exact: true }).click(),
      ]);
      expect(body.errors).toBeUndefined();
      await expect(confirmation).toBeHidden();
      await expect(status(page, requestId, 'Cancelled')).toBeVisible();
      const cancelled = await loadRequest(page, requestId, 'partner');
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.cancelledAt).toBeTruthy();
      expect(cancelled.statusHistory.map((e: { status: string }) => e.status))
        .toEqual(['SUBMITTED', 'IN_REVIEW', 'CANCELLED']);
      expect(cancelled.allowedActions).not.toContain('CANCEL_REQUEST');
      await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toHaveCount(0);
      expect((await loadRequest(counselor, requestId, 'counselor')).status).toBe('CANCELLED');
      await test.info().attach('review-cancelled', { body: await page.screenshot(), contentType: 'image/png' });
    });

    const designRequestId = await createHospitalReworkRequest(page, `${code}-design`, {
      ...syntheticCtRoundTwo, name: `${code}-design-ct.zip`,
    });
    test.info().annotations.push({ type: 'request', description: designRequestId });
    await test.step('Prepare a second fresh request at PRODUCT_DESIGN', async () => {
      await startReview(counselor, designRequestId, code);
      await expect(async () => {
        await counselor.reload();
        await counselor.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
        await expect(counselor.getByRole('button', { name: 'Accept latest round', exact: true }))
          .toBeEnabled({ timeout: 1000 });
      }).toPass({ timeout: 60_000, intervals: [1000, 2000, 5000] });
      await counselor.getByRole('button', { name: 'Accept latest round', exact: true }).click();
      await counselor.getByRole('button', { name: /^Enter design stage$/i }).click();
      await expect(status(counselor, designRequestId, 'Converting 3D')).toBeVisible();
      await loadRequest(counselor, designRequestId, 'counselor', true);
      const chooser = counselor.waitForEvent('filechooser');
      await counselor.getByRole('button', { name: 'Upload converted 3D', exact: true }).click();
      const [body] = await Promise.all([
        counselor.waitForResponse(r => r.url().endsWith('/graphql')
          && r.request().postDataJSON()?.operationName === 'RegisterDesignFile').then(r => r.json()),
        (await chooser).setFiles(syntheticModel(`${code}-converted.stl`)),
      ]);
      expect(body.errors).toBeUndefined();
      await expect(async () => {
        const details = await loadRequest(counselor, designRequestId, 'counselor');
        expect(details.status).toBe('PRODUCT_DESIGN');
        await expect(status(counselor, designRequestId, 'Product design')).toBeVisible();
      }).toPass({ timeout: 30_000, intervals: [1000, 2000, 5000] });
    });
    await test.step('Hospital has no direct cancellation action during PRODUCT_DESIGN', async () => {
      const design = await loadRequest(page, designRequestId, 'partner');
      expect(design.status).toBe('PRODUCT_DESIGN');
      expect(design.allowedActions).not.toContain('CANCEL_REQUEST');
      await expect(status(page, designRequestId, 'Product design')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'How to cancel', exact: true })).toBeVisible();
      await page.reload();
      await expect(status(page, designRequestId, 'Product design')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toHaveCount(0);
      await test.info().attach('design-direct-cancel-unavailable', { body: await page.screenshot(), contentType: 'image/png' });
      const result = { reviewRequest: requestId, reviewResult: 'CANCELLED',
        designRequest: designRequestId, designStatus: 'PRODUCT_DESIGN', directCancelAvailable: false };
      await test.info().attach('cancellation-results', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
      console.log(JSON.stringify(result));
    });
  } finally {
    await counselorContext.close();
  }
});
