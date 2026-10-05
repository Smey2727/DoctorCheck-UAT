import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, Locator, Page, test } from '@playwright/test';
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

async function designVersions(page: Page, requestId: string) {
  const [body] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/graphql')
      && response.request().postDataJSON()?.operationName === 'DesignFiles').then(response => response.json()),
    loadRequest(page, requestId, true),
  ]);
  expect(body.errors).toBeUndefined();
  return body.data.designFiles.filter((file: { category: string }) => file.category === 'DESIGN_RESULT');
}

async function downloadDesignResult(page: Page, card: Locator, document: any) {
  const button = card.getByRole('button', { name: document.documentNo, exact: true });
  await expect(button).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe(`${document.documentNo}.pdf`);
  const path = await download.path();
  expect(path).toBeTruthy();
  const bytes = await readFile(path!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBe(document.generatedFile.sizeBytes);
  return bytes;
}

async function hospitalDocuments(page: Page, requestId: string) {
  const [body] = await Promise.all([
    page.waitForResponse(async r => {
      if (!r.url().endsWith('/graphql') || r.request().postDataJSON()?.operationName !== 'Documents') return false;
      const body = await r.json().catch(() => null);
      return body?.data?.documents?.some((document: any) =>
        document.requestNo === requestId && document.documentType === 'DESIGN_RESULT_DOCUMENT');
    }).then(r => r.json()),
    page.goto(`/requests/${requestId}/model`),
  ]);
  expect(body.errors).toBeUndefined();
  return body.data.documents.filter((document: any) =>
    document.requestNo === requestId && document.documentType === 'DESIGN_RESULT_DOCUMENT');
}

// Compare persisted content and identity; latest changes when v2 is uploaded.
function preservedRevision(file: any) {
  return {
    id: file.id, version: file.version, category: file.category,
    createdAt: file.createdAt, uploadedByUserId: file.uploadedByUserId,
    file: { id: file.file.id, originalName: file.file.originalName, sizeBytes: file.file.sizeBytes, objectKey: file.file.objectKey },
    specification: file.specification,
  };
}

// TC-CS-018: Hospital sees each shared revision with its matching Design Result document.
test('TC-CS-018: Hospital sees Revision 2 with its matching Design Result and unchanged Revision 1', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-CS-018-${randomUUID().slice(0, 8)}`;
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
    const originalVersions = await designVersions(page, requestId);
    expect(originalVersions).toHaveLength(1);
    const revisionOne = preservedRevision(originalVersions[0]);
    const partnerPage = await hospitalContext.newPage();
    const firstSharedCard = partnerPage.getByRole('article').filter({
      has: partnerPage.getByRole('button', { name: /^v1 .*Design result Shared/ }),
    });
    let originalDocument: any;
    let originalPdf: Buffer;
    let originalSharedRecord: { notes: string[]; document: string | null };
    await test.step('Hospital requests a revision to Revision 1', async () => {
      const documents = await hospitalDocuments(partnerPage, requestId);
      expect(documents).toHaveLength(1);
      originalDocument = documents[0];
      expect(originalDocument).toMatchObject({ sourceAttachmentId: revisionOne.id,
        file: { id: revisionOne.file.id, originalName: `${caseCode}-design-v1.stl` } });
      expect(originalDocument.publishedAt).toBeTruthy();
      await expect(firstSharedCard).toBeVisible();
      originalPdf = await downloadDesignResult(partnerPage, firstSharedCard, originalDocument);
      originalSharedRecord = {
        notes: await firstSharedCard.getByRole('paragraph').allTextContents(),
        document: await firstSharedCard.getByRole('button', { name: /^DSN-/ }).textContent(),
      };
      const decision = partnerPage.getByRole('region', { name: 'Final case decision', exact: true });
      await decision.getByRole('combobox', { name: /^Revision reason/ }).selectOption({ label: 'Dimensions or thickness' });
      await decision.getByRole('textbox', { name: 'Revision memo or optional approval comment', exact: true })
        .fill(`${caseCode}: Please increase dimensions to 12 mm.`);
      await decision.getByRole('button', { name: 'Request revision', exact: true }).click();
      const confirmation = partnerPage.getByRole('alertdialog', { name: 'Request a design revision?', exact: true });
      await confirmation.getByRole('button', { name: 'Request revision', exact: true }).click();
      await expect(confirmation).toBeHidden();
      await expect(async () => {
        const request = await loadRequest(page, requestId);
        expect(request.details.status).toBe('REVISION_REQUESTED');
      }).toPass({ timeout: 15000 });
    });
    await test.step('Counselor registers and reshares Revision 2', async () => {
      await loadRequest(page, requestId, true);
      await uploadDesign(page, requestId, caseCode, 2, 12);
      await shareDesign(page, requestId, caseCode, 2);
    });
    await test.step('Revision 1 is preserved and Revision 2 is shared', async () => {
      const versions = await designVersions(page, requestId);
      expect(versions).toHaveLength(2);
      const old = versions.find((file: any) => file.version === 1);
      const latest = versions.find((file: any) => file.version === 2);
      expect(old).toBeDefined();
      expect(preservedRevision(old)).toEqual(revisionOne);
      expect(old.latest).toBe(false);
      expect(latest).toMatchObject({ latest: true, file: { originalName: `${caseCode}-design-v2.stl` },
        specification: { dimensions: { widthMm: '12.000', heightMm: '12.000', thicknessMm: '12.000' } } });
      expect(latest.id).not.toBe(old.id);
      expect(latest.file.id).not.toBe(old.file.id);
      const documents = await hospitalDocuments(partnerPage, requestId);
      expect(documents).toHaveLength(2);
      const oldDocument = documents.find((document: any) => document.sourceAttachmentId === old.id);
      const newDocument = documents.find((document: any) => document.sourceAttachmentId === latest.id);
      expect(oldDocument).toEqual(originalDocument);
      expect(newDocument).toMatchObject({
        sourceAttachmentId: latest.id,
        file: { id: latest.file.id, originalName: `${caseCode}-design-v2.stl` },
        partnerReviewNote: `${caseCode}: Please review synthetic design revision 2.`,
        generatedFile: { contentType: 'application/pdf', status: 'AVAILABLE' },
      });
      expect(newDocument.publishedAt).toBeTruthy();
      expect(newDocument.id).not.toBe(oldDocument.id);
      await expect(partnerPage.getByRole('button', { name: 'Approve v2', exact: true })).toBeVisible();
      await expect(firstSharedCard).toBeVisible();
      // The decision badge changes to Revision requested; the shared content must not.
      expect({
        notes: await firstSharedCard.getByRole('paragraph').allTextContents(),
        document: await firstSharedCard.getByRole('button', { name: /^DSN-/ }).textContent(),
      }).toEqual(originalSharedRecord);
      await expect(firstSharedCard.getByText('Revision requested', { exact: true })).toBeVisible();
      const secondSharedCard = partnerPage.getByRole('article').filter({
        has: partnerPage.getByRole('button', { name: /^v2 .*Design result Shared/ }),
      });
      await expect(secondSharedCard).toContainText(`${caseCode}-design-v2.stl`);
      await expect(secondSharedCard).toContainText(`${caseCode}: Please review synthetic design revision 2.`);
      const revisionTwoPdf = await downloadDesignResult(partnerPage, secondSharedCard, newDocument);
      const revisionOnePdf = await downloadDesignResult(partnerPage, firstSharedCard, oldDocument);
      expect(revisionOnePdf.equals(originalPdf)).toBe(true);
      expect(revisionTwoPdf.equals(originalPdf)).toBe(false);
    });
  } finally {
    await hospitalContext.close();
  }
});
