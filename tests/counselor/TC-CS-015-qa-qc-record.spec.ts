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

// TC-CS-015: QA/QC is an independent record; its save and finalization must not change workflow status.
test('TC-CS-015: QA/QC saves and finalizes independently without gating production or dispatch', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-CS-015-${randomUUID().slice(0, 8)}`;
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
    const verification = await page.context().newPage();
    const beforeSave = await loadRequest(verification, requestId);
    expect(beforeSave.details.status).toBe('PRODUCTION_HANDOFF');
    await page.goto(`/requests/${requestId}/qc`);
    await expect(page.getByRole('button', { name: 'Save QC draft', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox')).toHaveCount(5);
    for (const box of await page.getByRole('combobox').all()) await box.selectOption({ label: 'Pass' });
    for (const input of await page.getByRole('textbox', { name: 'Target / nominal', exact: true }).all()) await input.fill('10');
    for (const input of await page.getByRole('textbox', { name: 'Measured', exact: true }).all()) await input.fill('10');
    const qcNote = `${caseCode}: Synthetic UAT inspection only. No physical product. Do not manufacture or ship.`;
    await page.getByRole('textbox', { name: 'Notes', exact: true }).fill(qcNote);
    const [saved] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'SaveQcInspection').then(r=>r.json()),
      page.getByRole('button', { name: 'Save QC draft', exact: true }).click(),
    ]);
    expect(saved.errors).toBeUndefined();
    const draft = saved.data.saveQcInspection;
    expect(draft).toMatchObject({
      roundNo: 1, revision: 1, overallResult: 'PASS', notes: qcNote,
      inspectorUserId: counselor.id, signedAt: null, signedByUserId: null,
      formDocumentId: null,
    });
    expect(draft.qcNo).toMatch(/^QC-/);
    expect(draft.items).toHaveLength(4);
    for (const item of draft.items) expect(item.state).toBe('PASS');
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(qcNote);
    await expect(page.getByRole('combobox', { name: 'Overall result*', exact: true })).toHaveValue('PASS');
    for (const input of await page.getByRole('textbox', { name: 'Measured', exact: true }).all()) {
      await expect(input).toHaveValue('10.00');
    }
    const afterSave = await loadRequest(verification, requestId);
    expect(afterSave.details.status).toBe(beforeSave.details.status);
    expect(afterSave.details.statusHistory).toEqual(beforeSave.details.statusHistory);

    const managerContext = await browser.newContext({ baseURL });
    try {
      const managerPage = await managerContext.newPage();
      await signIn(managerPage, USERS.manager);
      await managerPage.goto(`/manager/requests/${requestId}`);
      await test.step('Unsigned QC does not block production or synthetic dispatch', async () => {
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
        await managerPage.getByRole('button', { name: 'Record shipment', exact: true }).click();
        const shipment = managerPage.getByRole('dialog', { name: /^Record shipment/ });
        await shipment.getByRole('textbox', { name: 'Carrier*', exact: true }).fill('UAT simulation - do not ship');
        await shipment.getByRole('textbox', { name: 'Tracking number', exact: true }).fill(`${caseCode}-NOT-A-SHIPMENT`);
        await shipment.getByRole('button', { name: 'Record shipment', exact: true }).click();
        await expect(shipment).toBeHidden();
      });
      const beforeSign = await loadRequest(verification, requestId);
      expect(beforeSign.details.status).toBe('SHIPPED');
      await test.step('Finalize the saved QC record without changing request status', async () => {
        await page.reload();
        await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(qcNote);
        await page.getByRole('button', { name: 'Sign & issue QC Form', exact: true }).click();
        const sign = page.getByRole('dialog', { name: /^Sign QC Form/ });
        await sign.getByRole('textbox', { name: /^Password/ }).fill(PASSWORD);
        const [signedBody] = await Promise.all([
          page.waitForResponse(r => r.url().endsWith('/graphql')
            && r.request().postDataJSON()?.operationName === 'SignQcInspection').then(r => r.json()),
          sign.getByRole('button', { name: 'Sign & issue QC Form', exact: true }).click(),
        ]);
        expect(signedBody.errors).toBeUndefined();
        const document = signedBody.data.signQcInspection;
        expect(document).toMatchObject({
          requestNo: requestId, documentType: 'QC_FORM', issuedByUserId: counselor.id,
        });
        expect(document.generatedFile).toMatchObject({ contentType: 'application/pdf', status: 'AVAILABLE' });
        await expect(sign).toBeHidden();
        // Verify persisted data in a fresh tab, independent of mutation-triggered refetches.
        const [qcBody] = await Promise.all([
          verification.waitForResponse(async r => {
            if (!r.url().endsWith('/graphql')) return false;
            const body = await r.json().catch(() => null);
            return body?.data?.qcInspection?.id === draft.id;
          }).then(r => r.json()),
          verification.goto(`/requests/${requestId}/qc`),
        ]);
        const signed = qcBody.data.qcInspection;
        expect(signed).toMatchObject({
          id: draft.id, qcNo: draft.qcNo, roundNo: 1, overallResult: 'PASS',
          notes: qcNote, signedByUserId: counselor.id,
        });
        expect(signed.signedAt).toBeTruthy();
        expect(Number.isFinite(Date.parse(signed.signedAt))).toBe(true);
        expect(signed.formDocumentId).toBe(document.id);
        for (const key of ['targetWidthMm', 'targetHeightMm', 'targetThicknessMm', 'targetWeightG',
          'measuredWidthMm', 'measuredHeightMm', 'measuredThicknessMm', 'measuredWeightG']) {
          expect(signed[key]).toBe(draft[key]);
        }
        const checklist = (items: { checkpoint: string; state: string; sortOrder: number }[]) =>
          items.map(({ checkpoint, state, sortOrder }) => ({ checkpoint, state, sortOrder }));
        expect(checklist(signed.items)).toEqual(checklist(draft.items));
        await expect(sign).toBeHidden();
        await page.reload();
        await expect(page.locator('main')).toContainText(draft.qcNo);
        const afterSign = await loadRequest(verification, requestId);
        expect(afterSign.details.status).toBe(beforeSign.details.status);
        expect(afterSign.details.statusHistory).toEqual(beforeSign.details.statusHistory);
      });
    } finally { await managerContext.close(); }
  } finally { await hospitalContext.close(); }
});
