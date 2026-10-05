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

// TC-MG-016: Use an independent synthetic request to verify completion is independent of invoice payment.
test('TC-MG-016: Partial invoice payment does not block shipment completion', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-MG-016-${randomUUID().slice(0, 8)}`;
    const hospitalUser = await signIn(hospitalPage, USERS.hospital);
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
      // Financial fields are visible to the manager, but masked for the counselor.
      const [requestBody] = await Promise.all([
        manager.waitForResponse(r => r.url().endsWith('/graphql')
          && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
        operations(),
      ]);
      expect(requestBody.errors).toBeUndefined();
      const request = requestBody.data.request.details;
      expect(request.financialAgencyUserId).toBeNull();
      expect(Number(request.quotedPrice)).toBeGreaterThan(0);
      const amount = request.quotedPrice;
      const summaryResponse = () => manager.waitForResponse(r => r.url().endsWith('/graphql')
        && r.request().postDataJSON()?.operationName === 'BillingSummary').then(r => r.json());
      const [initial] = await Promise.all([
        summaryResponse(), manager.getByRole('link', { name: /Billing row/ }).click(),
      ]);
      const billingUrl = manager.url();
      function billingRecord(body: any) {
        expect(body.errors).toBeUndefined();
        const groups = body.data.billingSummary.directPartnerGroups;
        const group = groups.find((g: any) => g.requests.some((r: any) => r.requestNo === requestId));
        expect(group).toBeDefined();
        expect(group).toMatchObject({
          billedToUserId: hospitalUser.id, billedToName: request.hospital, viaAgency: false,
        });
        const invoice = group.requests.find((r: any) => r.requestNo === requestId);
        expect(invoice.calculatedAmount).toBe(amount);
        expect(invoice.currency).toBe(request.priceCurrency);
        return invoice;
      }
      async function reloadBilling() {
        const [body] = await Promise.all([summaryResponse(), manager.goto(billingUrl)]);
        return billingRecord(body);
      }
      async function openGroup() {
        await manager.getByRole('row').filter({ hasText: request.hospital })
          .getByRole('button', { name: 'Open', exact: true }).click();
      }
      const requestLink = manager.getByRole('link', { name: requestId, exact: true });
      async function evidence(stage: string, invoice: any) {
        await test.info().attach(stage, {
          body: JSON.stringify({ payer: request.hospital, payerId: hospitalUser.id, savedPrice: amount, invoice }, null, 2),
          contentType: 'application/json',
        });
      }
      await test.step('PENDING invoice belongs to the Hospital and defaults to the saved price', async () => {
        expect(billingRecord(initial).invoiceStatus).toBe('PENDING');
        const pending = await reloadBilling();
        expect(pending).toMatchObject({ invoiceStatus: 'PENDING', paidAmount: '0.00' });
        await openGroup();
        const card = requestLink.locator('xpath=ancestor::div[.//button[normalize-space()="Issue invoice"]][1]');
        await expect(card.getByRole('textbox', { name: /^Invoice amount/ })).toHaveValue(amount);
        await evidence('pending', pending);
      });
      await test.step('Issue invoice and verify persisted INVOICED amount and outstanding balance', async () => {
        const card = requestLink.locator('xpath=ancestor::div[.//button[normalize-space()="Issue invoice"]][1]');
        await card.getByRole('button', { name: 'Issue invoice', exact: true }).click();
        const confirmation = manager.getByRole('alertdialog', { name: 'Issue this invoice?', exact: true });
        await confirmation.getByRole('checkbox').check();
        await confirmation.getByRole('button', { name: 'Issue invoice', exact: true }).click();
        await expect(confirmation).toBeHidden();
        const invoiced = await reloadBilling();
        expect(invoiced).toMatchObject({ invoiceStatus: 'INVOICED', amount, paidAmount: '0.00', outstanding: amount });
        expect(invoiced.invoicedAt).toBeTruthy();
        await evidence('invoiced', invoiced);
        await openGroup();
      });
      const partial = (Math.floor(Number(amount) * 100 / 2) / 100).toFixed(2);
      const remaining = (Number(amount) - Number(partial)).toFixed(2);
      expect(Number(partial)).toBeGreaterThan(0);
      expect(Number(remaining)).toBeGreaterThan(0);
      async function recordPayment(payment: string) {
        const card = requestLink.locator('xpath=ancestor::div[.//button[normalize-space()="Record payment"]][1]');
        await card.getByRole('textbox', { name: /^Payment amount/ }).fill(payment);
        await card.getByRole('button', { name: 'Record payment', exact: true }).click();
        const confirmation = manager.getByRole('alertdialog', { name: 'Record this payment?', exact: true });
        await confirmation.getByRole('checkbox').check();
        await confirmation.getByRole('button', { name: 'Record payment', exact: true }).click();
        await expect(confirmation).toBeHidden();
      }
      await test.step('Partial payment leaves the invoice INVOICED with a remaining balance', async () => {
        await recordPayment(partial);
        const invoice = await reloadBilling();
        expect(invoice).toMatchObject({ invoiceStatus: 'INVOICED', amount, paidAmount: partial, outstanding: remaining });
        expect((await loadRequest(page, requestId)).details.status).toBe('SHIPPED');
        await evidence('partial-payment', invoice);
      });
      await test.step('Complete the shipment while its invoice is only partially paid', async () => {
        const before = await operations();
        expect(before).toMatchObject({ shipmentStatus: 'SHIPPED', invoiceStatus: 'INVOICED', paidAmount: partial });
        const complete = manager.getByRole('button', { name: 'Mark complete', exact: true });
        await expect(complete).toBeEnabled();
        await complete.click();
        const confirmation = manager.getByRole('alertdialog', { name: 'Complete this shipment?', exact: true });
        await confirmation.getByRole('button', { name: 'Mark complete', exact: true }).click();
        await expect(confirmation).toBeHidden();
        expect(await operations()).toMatchObject({ shipmentStatus: 'COMPLETED', invoiceStatus: 'INVOICED', paidAmount: partial });
        expect((await loadRequest(page, requestId)).details.status).toBe('COMPLETED');
        await expect(status(page, requestId, 'Completed')).toBeVisible();
        const invoice = await reloadBilling();
        expect(invoice).toMatchObject({ shipmentStatus: 'COMPLETED', invoiceStatus: 'INVOICED', amount, paidAmount: partial, outstanding: remaining });
        await evidence('completed-with-partial-payment', invoice);
        await openGroup();
        await requestLink.scrollIntoViewIfNeeded();
        await test.info().attach('completed-with-unpaid-balance', { body: await manager.screenshot(), contentType: 'image/png' });
      });
      await test.step('Only full payment changes the invoice to PAID; request remains COMPLETED', async () => {
        await recordPayment(remaining);
        const invoice = await reloadBilling();
        expect(invoice).toMatchObject({ shipmentStatus: 'COMPLETED', invoiceStatus: 'PAID', amount, paidAmount: amount, outstanding: '0.00' });
        expect((await loadRequest(page, requestId)).details.status).toBe('COMPLETED');
        await evidence('fully-paid-request-still-completed', invoice);
      });
      console.log(JSON.stringify({ requestId, amount, partialPayment: partial, remainingAfterPartial: remaining,
        requestAfterPartial: 'COMPLETED', invoiceAfterPartial: 'INVOICED', invoiceAfterFull: 'PAID', result: 'PASSED' }));
    } finally { await managerContext.close(); }
  } finally { await hospitalContext.close(); }
});
