import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS, PASSWORD } from '../helpers/auth';
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

// TC-CS-009: Completion sharing requires Completed and must preserve its first audit record.
test('TC-CS-009: Completion can be shared once only after Completed', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-CS-009-${randomUUID().slice(0, 8)}`;
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
      const managerPage = await managerContext.newPage();
      await signIn(managerPage, USERS.manager);
      await managerPage.goto(`/manager/requests/${requestId}`);
      await expect(managerPage.getByRole('heading', { name: `Request ${requestId}`, exact: true })).toBeVisible();
      await test.step('Prepare synthetic production, QC and shipment', async () => {
        await managerPage.getByRole('button', { name: 'Update production', exact: true }).click();
        const production = managerPage.getByRole('dialog', { name: 'Production details', exact: true });
        await production.getByRole('textbox', { name: 'Lot number*', exact: true }).fill(`${caseCode}-UAT-ONLY`);
        await production.getByRole('combobox', { name: 'Production status*', exact: true }).selectOption({ label: 'Done' });
        await production.getByRole('button', { name: 'Save production', exact: true }).click();
        await expect(production).toBeHidden();
        await managerPage.getByRole('button', { name: 'Log partner call', exact: true }).click();
        const call = managerPage.getByRole('dialog', { name: /^Log partner call/ });
        await call.getByRole('textbox', { name: 'Spoke with*', exact: true }).fill('Synthetic UAT contact - no real call');
        await call.getByRole('radio', { name: 'OK to ship', exact: true }).check();
        await call.getByRole('textbox', { name: 'Note', exact: true }).fill(`${caseCode}: Simulated check only. Do not ship.`);
        await call.getByRole('button', { name: 'Log call', exact: true }).click();
        await expect(call).toBeHidden();

        await page.goto(`/requests/${requestId}/qc`);
        await expect(page.getByRole('button', { name: 'Sign & issue QC Form', exact: true })).toBeVisible();
        await expect(page.getByRole('combobox')).toHaveCount(5);
        for (const box of await page.getByRole('combobox').all()) await box.selectOption({ label: 'Pass' });
        for (const input of await page.getByRole('textbox', { name: 'Target / nominal', exact: true }).all()) await input.fill('10');
        for (const input of await page.getByRole('textbox', { name: 'Measured', exact: true }).all()) await input.fill('10');
        await page.getByRole('textbox', { name: 'Notes', exact: true }).fill(`${caseCode}: Synthetic UAT inspection only. No physical product. Do not manufacture or ship.`);
        await page.getByRole('button', { name: 'Sign & issue QC Form', exact: true }).click();
        const sign = page.getByRole('dialog', { name: /^Sign QC Form/ });
        await sign.getByRole('textbox', { name: /^Password/ }).fill(PASSWORD);
        await sign.getByRole('button', { name: 'Sign & issue QC Form', exact: true }).click();
        await expect(sign).toBeHidden();

        await managerPage.goto(`/manager/requests/${requestId}`);
        await managerPage.getByRole('button', { name: 'Record shipment', exact: true }).click();
        const shipment = managerPage.getByRole('dialog', { name: /^Record shipment/ });
        await shipment.getByRole('textbox', { name: 'Carrier*', exact: true }).fill('UAT simulation - do not ship');
        await shipment.getByRole('textbox', { name: 'Tracking number', exact: true }).fill(`${caseCode}-NOT-A-SHIPMENT`);
        await shipment.getByRole('button', { name: 'Record shipment', exact: true }).click();
        await expect(shipment).toBeHidden();
      });
      const notify = page.getByRole('button', { name: 'Notify partner of completion', exact: true });
      await test.step('Sharing completion is unavailable while Shipped', async () => {
        const shipped = await loadRequest(page, requestId);
        expect(shipped.details.status).toBe('SHIPPED');
        expect(shipped.details.completionSharedAt).toBeNull();
        expect(shipped.details.allowedActions).not.toContain('SHARE_COMPLETION');
        await expect(status(page, requestId, 'Shipped')).toBeVisible();
        await expect(notify).toHaveCount(0);
      });
      await test.step('Manager marks the synthetic shipment Completed', async () => {
        await managerPage.getByRole('button', { name: 'Mark complete', exact: true }).click();
        const complete = managerPage.getByRole('alertdialog', { name: 'Complete this shipment?', exact: true });
        await complete.getByRole('button', { name: 'Mark complete', exact: true }).click();
        await expect(complete).toBeHidden();
        const completed = await loadRequest(page, requestId);
        expect(completed.details.status).toBe('COMPLETED');
        expect(completed.details.completionSharedAt).toBeNull();
        expect(completed.details.allowedActions).toContain('SHARE_COMPLETION');
        await expect(status(page, requestId, 'Completed')).toBeVisible();
        await expect(notify).toBeEnabled();
      });
      // Keep a second tab open before sharing to exercise a genuine duplicate attempt.
      const stalePage = await page.context().newPage();
      await loadRequest(stalePage, requestId);
      const duplicateButton = stalePage.getByRole('button', { name: 'Notify partner of completion', exact: true });
      await expect(duplicateButton).toBeEnabled();
      await test.step('Share completion once and persist the counselor and server time', async () => {
        const [body] = await Promise.all([
          page.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'ShareRequestCompletion').then(r => r.json()),
          notify.click(),
        ]);
        expect(body.errors).toBeUndefined();
        expect(body.data.shareRequestCompletion).toMatchObject({ requestNo: requestId, status: 'COMPLETED' });
        await expect(notify).toHaveCount(0);
      });
      const saved = await loadRequest(page, requestId);
      expect(saved.details.completionSharedByUserName).toBe(counselor.displayName);
      expect(saved.details.completionSharedAt).toBeTruthy();
      expect(Number.isFinite(Date.parse(saved.details.completionSharedAt))).toBe(true);
      await expect(page.getByRole('term').filter({ hasText: /^Completion shared by$/ })
        .locator('xpath=following-sibling::dd[1]')).toHaveText(counselor.displayName);
      const displayedTime = page.getByRole('term').filter({ hasText: /^Completion shared at$/ })
        .locator('xpath=following-sibling::dd[1]');
      await expect(displayedTime).toBeVisible();
      await expect(displayedTime).not.toHaveText('-');
      await test.step('A duplicate attempt preserves the original completion share', async () => {
        const [duplicate] = await Promise.all([
          stalePage.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'ShareRequestCompletion').then(r => r.json()),
          duplicateButton.click(),
        ]);
        // The server handles duplicate calls idempotently rather than returning an error.
        expect(duplicate.errors).toBeUndefined();
        expect(duplicate.data.shareRequestCompletion).toMatchObject({ requestNo: requestId, status: 'COMPLETED' });
        expect(duplicate.data.shareRequestCompletion.allowedActions).not.toContain('SHARE_COMPLETION');
        const persisted = await loadRequest(page, requestId);
        expect(persisted.details.completionSharedAt).toBe(saved.details.completionSharedAt);
        expect(persisted.details.completionSharedByUserName).toBe(saved.details.completionSharedByUserName);
        await expect(status(page, requestId, 'Completed')).toBeVisible();
        await expect(notify).toHaveCount(0);
        await stalePage.close();
      });
    } finally { await managerContext.close(); }
  } finally { await hospitalContext.close(); }
});
