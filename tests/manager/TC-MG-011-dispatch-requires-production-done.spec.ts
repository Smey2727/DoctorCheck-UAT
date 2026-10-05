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

async function uploadDesign(page: Page, requestId: string, caseCode: string, version: number, size: number) {
  await page.getByRole('button', { name: 'Upload design result', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload design result', exact: true });
  await dialog.getByRole('spinbutton', { name: 'Width (mm)*', exact: true }).fill(String(size));
  await dialog.getByRole('spinbutton', { name: 'Height (mm)*', exact: true }).fill(String(size));
  await dialog.getByRole('spinbutton', { name: 'Thickness (mm)*', exact: true }).fill(String(size));
  const designName = `${caseCode}-design-v${version}.stl`;
  await dialog.locator('input[type="file"]').setInputFiles(syntheticModel(designName, size));
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/graphql')
      && response.request().postDataJSON()?.operationName === 'RegisterDesignFile'),
    dialog.getByRole('button', { name: 'Upload design result', exact: true }).click(),
  ]);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  expect(body.data.registerDesignFile).toMatchObject({
    requestNo: requestId,
    status: version === 1 ? 'PRODUCT_DESIGN' : 'REVISION_REQUESTED',
  });
  await expect(dialog).toBeHidden();
}

async function shareDesign(page: Page, requestId: string, caseCode: string, version: number) {
  await expect(async () => {
    await loadRequest(page, requestId, true);
    await expect(page.getByRole('button', { name: `Review and share v${version}`, exact: true })).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 60_000, intervals: [1000, 2000, 5000] });
  await page.getByRole('button', { name: `Review and share v${version}`, exact: true }).click();
  const generate = page.getByRole('dialog', { name: 'Generate design document', exact: true });
  await generate.getByRole('textbox', { name: 'Counselor review note for partner', exact: true })
    .fill(`${caseCode}: Please review synthetic design revision ${version}.`);
  await generate.getByRole('button', { name: 'Generate and preview', exact: true }).click();
  await expect(generate).toBeHidden();
  const preview = page.getByRole('dialog', { name: 'Design-Result Document print view', exact: true });
  await expect(preview).toContainText(`${caseCode}-design-v${version}.stl`);
  await preview.getByRole('checkbox', { name: /^I reviewed this exact document/ }).check();
  await preview.getByRole('button', { name: 'Share design with partner', exact: true }).click();
  await expect(preview).toBeHidden();
  const request = await loadRequest(page, requestId);
  expect(request.details.status).toBe('REVIEW_REQUESTED');
  await expect(status(page, requestId, 'Review requested')).toBeVisible();
}

// TC-MG-011: Use an independent synthetic request to verify dispatch gating and hospital notification.
test('TC-MG-011: Dispatch requires completed production and notifies the hospital', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-MG-011-${randomUUID().slice(0, 8)}`;
    await signIn(hospitalPage, USERS.hospital);
    const requestId = await createHospitalReworkRequest(hospitalPage, caseCode, {
      ...syntheticCtRoundTwo, name: `${caseCode}-ct.zip`,
    });
    test.info().annotations.push({ type: 'request', description: requestId });
    await hospitalPage.close();
    await signIn(page, USERS.counselor);
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
    await test.step('Register and share Revision 1', async () => {
      await uploadDesign(page, requestId, caseCode, 1, 10);
      await shareDesign(page, requestId, caseCode, 1);
    });
    await page.getByRole('button', { name: 'Production handoff', exact: true }).click();
    const blocked = await loadRequest(page, requestId);
    expect(blocked.details.status).toBe('REVIEW_REQUESTED');
    expect(blocked.details.allowedActions).not.toContain('HANDOFF_TO_PRODUCTION');
    await expect(status(page, requestId, 'Review requested')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Handoff to production', exact: true })).toHaveCount(0);
    const partnerPage = await hospitalContext.newPage();
    await partnerPage.goto(`/requests/${requestId}/model`);
    await partnerPage.getByRole('button', { name: 'Approve v1', exact: true }).click();
    const approval = partnerPage.getByRole('alertdialog', { name: 'Approve this design?', exact: true });
    await approval.getByRole('checkbox', { name: /^I reviewed/ }).check();
    await approval.getByRole('button', { name: 'Approve v1', exact: true }).click();
    await expect(approval).toBeHidden();
    const approved = await loadRequest(page, requestId);
    expect(approved.details.status).toBe('DESIGN_CONFIRMED');
    expect(approved.details.allowedActions).toContain('HANDOFF_TO_PRODUCTION');
    await page.getByRole('button', { name: 'Handoff to production', exact: true }).click();
    const handoff = page.getByRole('alertdialog', { name: 'Send this request to production?', exact: true });
    await handoff.getByRole('checkbox', { name: /^I confirm the approved design/ }).check();
    await handoff.getByRole('button', { name: 'Handoff to production', exact: true }).click();
    await expect(handoff).toBeHidden();
    const managerContext = await browser.newContext({ baseURL });
    try {
      const manager = await managerContext.newPage();
      await signIn(manager, USERS.manager);
      async function operations() {
        const [response] = await Promise.all([
          manager.waitForResponse(r => r.url().endsWith('/graphql')
            && r.request().postDataJSON()?.operationName === 'RequestOperations'),
          manager.goto(`/manager/requests/${requestId}`),
        ]);
        const body = await response.json();
        expect(body.errors).toBeUndefined();
        return body.data.requestOperations;
      }
      const dispatch = manager.getByRole('button', { name: 'Record shipment', exact: true });
      const production = manager.getByRole('dialog', { name: 'Production details', exact: true });
      await operations();
      await test.step('Dispatch is unavailable before production DONE', async () => {
        await manager.getByRole('button', { name: 'Update production', exact: true }).click();
        await production.getByRole('combobox', { name: 'Production status*', exact: true }).selectOption('IN_PRODUCTION');
        await production.getByRole('button', { name: 'Save production', exact: true }).click();
        await expect(production).toBeHidden();
        const before = await operations();
        expect(before.productionStatus).toBe('IN_PRODUCTION');
        expect(before.shipmentStatus).toBe('PENDING');
        await expect(manager.getByText('Next: Mark production Done with a lot no. to unlock shipping.', { exact: true })).toBeVisible();
        await expect(dispatch).toHaveCount(0);
        expect((await loadRequest(page, requestId)).details.status).toBe('PRODUCTION_HANDOFF');
        await test.info().attach('dispatch-blocked-before-done', {
          body: await manager.screenshot(), contentType: 'image/png',
        });
      });
      await test.step('Complete synthetic production and record the required pre-shipment call check', async () => {
        await manager.getByRole('button', { name: 'Update production', exact: true }).click();
        await production.getByRole('combobox', { name: 'Production status*', exact: true }).selectOption('DONE');
        await production.getByRole('textbox', { name: /^Lot number/ }).fill(`${caseCode}-UAT-ONLY`);
        await production.getByRole('button', { name: 'Save production', exact: true }).click();
        await expect(production).toBeHidden();
        await manager.getByRole('button', { name: 'Log partner call', exact: true }).click();
        const call = manager.getByRole('dialog', { name: /^Log partner call/ });
        await call.getByRole('textbox', { name: 'Spoke with*', exact: true }).fill('Synthetic UAT contact - no real call');
        await call.getByRole('radio', { name: 'OK to ship', exact: true }).check();
        await call.getByRole('textbox', { name: 'Note', exact: true }).fill(`${caseCode}: Simulated check only. Do not ship.`);
        await call.getByRole('button', { name: 'Log call', exact: true }).click();
        await expect(call).toBeHidden();
        expect((await operations()).productionStatus).toBe('DONE');
      });
      const carrier = 'UAT simulation - do not ship';
      const trackingNumber = `${caseCode}-NOT-A-SHIPMENT`;
      const shipDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      await test.step('Dispatch with carrier, tracking number and ship date', async () => {
        await expect(dispatch).toBeEnabled();
        await dispatch.click();
        const shipment = manager.getByRole('dialog', { name: /^Record shipment/ });
        await shipment.getByRole('textbox', { name: 'Carrier*', exact: true }).fill(carrier);
        await shipment.getByRole('textbox', { name: 'Tracking number', exact: true }).fill(trackingNumber);
        await shipment.getByLabel(/^Ship date/).fill(shipDate);
        await shipment.getByRole('button', { name: 'Record shipment', exact: true }).click();
        await expect(shipment).toBeHidden();
        const saved = await operations();
        await test.info().attach('saved-shipment', {
          body: JSON.stringify({ requestId, shipDate, ...saved }, null, 2), contentType: 'application/json',
        });
        expect(saved).toMatchObject({
          shipmentStatus: 'SHIPPED', carrier, trackingNo: trackingNumber, shipDate,
        });
        expect((await loadRequest(page, requestId)).details.status).toBe('SHIPPED');
        await expect(manager.getByText(carrier, { exact: true })).toBeVisible();
        await expect(manager.getByText(trackingNumber, { exact: true })).toBeVisible();
        await test.info().attach('shipment-shipped', { body: await manager.screenshot(), contentType: 'image/png' });
      });
      await test.step('Hospital receives the shipment notification for this request', async () => {
        await partnerPage.goto('/notifications');
        // Shipment notifications omit the request number from the card text.
        // Verify the destination of the newest dispatched notification instead.
        const notification = partnerPage.getByRole('article').filter({ hasText: 'Shipment dispatched' }).first();
        await expect(notification).toBeVisible();
        await expect(notification).toContainText('Your request has been shipped.');
        await test.info().attach('hospital-shipment-notification', {
          body: await notification.innerText(), contentType: 'text/plain',
        });
        await test.info().attach('hospital-notified', { body: await partnerPage.screenshot(), contentType: 'image/png' });
        await notification.getByRole('button', { name: 'Open request', exact: true }).click();
        await expect(partnerPage).toHaveURL(new RegExp(`/partner/requests/${requestId}$`));
        await expect(status(partnerPage, requestId, 'Shipped')).toBeVisible();
      });
      console.log(JSON.stringify({ requestId, carrier, trackingNumber, shipDate, result: 'PASSED' }));
    } finally { await managerContext.close(); }
  } finally { await hospitalContext.close(); }
});
