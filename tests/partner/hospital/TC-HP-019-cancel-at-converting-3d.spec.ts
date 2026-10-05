import { randomUUID } from 'node:crypto';
import { expect, Page, Request, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';
import { createHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

function status(page: Page, requestId: string, label: string) {
  return page.getByRole('heading', { name: requestId, exact: true }).locator('..')
    .getByRole('button', { name: label, exact: true });
}

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

test('TC-HP-019: Direct cancellation at Converting 3D freezes the request', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const counselorContext = await browser.newContext({ baseURL });
  counselorContext.setDefaultTimeout(15_000);
  try {
    await signIn(page, 'hospital.c@saerosoft.com');
    const code = `TC-HP-019-${randomUUID().slice(0, 8)}`;
    const requestId = await createHospitalReworkRequest(page, code,
      { ...syntheticCtRoundTwo, name: `${code}-ct.zip` });
    test.info().annotations.push({ type: 'request', description: requestId });
    const counselor = await counselorContext.newPage();
    await signIn(counselor, USERS.counselor);
    let reviewRequest: Request;

    await test.step('Counselor accepts sources and enters CONVERTING_3D', async () => {
      await counselor.goto('/counselor/requests');
      await counselor.getByRole('searchbox', { name: /^Search request no\./ }).fill(requestId);
      const row = counselor.getByRole('row').filter({ has: counselor.getByRole('cell', { name: requestId, exact: true }) });
      await row.getByRole('button', { name: 'Claim', exact: true }).click();
      await expect(row.getByRole('button', { name: 'Claim', exact: true })).toBeHidden();
      await counselor.goto(`/counselor/requests/${requestId}`);
      await counselor.getByRole('button', { name: 'Start review', exact: true }).click();
      const note = counselor.getByRole('textbox', { name: 'Optional note for the status history', exact: true });
      await note.fill(`${code}: Synthetic CT source review.`);
      [reviewRequest] = await Promise.all([
        counselor.waitForRequest(r => r.url().endsWith('/graphql')
          && /mutation/.test(r.postDataJSON()?.query ?? '')),
        note.locator('..').getByRole('button', { name: 'Start review', exact: true }).click(),
      ]);
      await expect(status(counselor, requestId, 'In review')).toBeVisible();
      await expect(async () => {
        await counselor.reload();
        await counselor.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
        await expect(counselor.getByRole('button', { name: 'Accept latest round', exact: true })).toBeEnabled({ timeout: 1000 });
      }).toPass({ timeout: 60_000, intervals: [1000, 2000, 5000] });
      await counselor.getByRole('button', { name: 'Accept latest round', exact: true }).click();
      await counselor.getByRole('button', { name: /^Enter design stage$/i }).click();
      await expect(status(counselor, requestId, 'Converting 3D')).toBeVisible();
      const converting = await loadRequest(page, requestId, 'partner');
      expect(converting.status).toBe('CONVERTING_3D');
      expect(converting.allowedActions).toContain('CANCEL_REQUEST');
      await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeEnabled();
      await test.info().attach('converting-3d-cancel-available', { body: await page.screenshot(), contentType: 'image/png' });
    });

    await test.step('Hospital cancellation immediately changes the status to CANCELLED', async () => {
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
    });

    const cancelled = await loadRequest(page, requestId, 'partner');
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelledAt).toBeTruthy();
    expect(cancelled.statusHistory.map((e: { status: string }) => e.status).slice(-2))
      .toEqual(['CONVERTING_3D', 'CANCELLED']);
    await test.step('Cancelled request has no edit or resubmission actions, including direct form URLs', async () => {
      const forbidden = /^(Edit request|Edit draft|Save draft|Resume|Fix & resubmit|Resubmit request|Submit request|Change product or material|Cancel request)$/i;
      await expect(page.getByRole('button', { name: forbidden })).toHaveCount(0);
      await expect(page.getByRole('link', { name: forbidden })).toHaveCount(0);
      for (const action of ['UPDATE_DRAFT', 'SUBMIT_DRAFT', 'RESUBMIT_REQUEST', 'EDIT_SUBMITTED_FIELDS', 'SUBMIT_PRODUCT_MATERIAL_CHANGE', 'CANCEL_REQUEST']) {
        expect(cancelled.allowedActions).not.toContain(action);
      }
      await test.info().attach('cancelled-request-read-only', { body: await page.screenshot(), contentType: 'image/png' });
      for (const route of ['edit', 'resubmit']) {
        await page.goto(`/partner/requests/${requestId}/${route}`);
        await expect(page.getByRole('button', { name: forbidden })).toHaveCount(0);
        await expect(page.getByRole('textbox', { name: 'Case description', exact: true })).toHaveCount(0);
        await test.info().attach(`cancelled-${route}-unavailable`, { body: await page.screenshot(), contentType: 'image/png' });
      }
      const persisted = await loadRequest(page, requestId, 'partner');
      expect(persisted.status).toBe('CANCELLED');
      expect(persisted.statusHistory).toEqual(cancelled.statusHistory);
      expect(persisted.attachments.map((a: any) => a.id)).toEqual(cancelled.attachments.map((a: any) => a.id));
    });

    await test.step('Server rejects an attempt to restart review on the cancelled request', async () => {
      const authorization = await reviewRequest!.headerValue('authorization');
      expect(authorization).toBeTruthy();
      const response = await counselor.request.post(reviewRequest!.url(), {
        headers: { authorization: authorization! }, data: reviewRequest!.postDataJSON(),
      });
      const denied = await response.json();
      expect(denied.errors?.length).toBeGreaterThan(0);
      expect(JSON.stringify(denied.errors)).toMatch(/cancel|status|transition/i);
      const persisted = await loadRequest(counselor, requestId, 'counselor');
      expect(persisted.status).toBe('CANCELLED');
      expect(persisted.cancelledAt).toBe(cancelled.cancelledAt);
      expect(persisted.statusHistory).toEqual(cancelled.statusHistory);
      const result = { requestId, transition: 'CONVERTING_3D -> CANCELLED',
        readOnly: true, directEditAndResubmitUnavailable: true, serverReactivationRejected: true };
      await test.info().attach('cancellation-results', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
      console.log(JSON.stringify(result));
    });
  } finally {
    await counselorContext.close();
  }
});
