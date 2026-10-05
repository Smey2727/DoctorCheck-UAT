import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';
import { createHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';
import { syntheticModel } from '../../helpers/synthetic-model';

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

test('TC-HP-009: Hospital comments without changing status and requests a design revision', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-HP-009-${randomUUID().slice(0, 8)}`;
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
    const partnerPage = await hospitalContext.newPage();
    await partnerPage.goto(`/requests/${requestId}/model`);
    const comment = `${caseCode}: Please check the edge fit. Comment only; no revision requested yet.`;
    await test.step('Posting a comment persists feedback without changing the shared-design status', async () => {
      const before = await loadRequest(page, requestId);
      expect(before.details.status).toBe('REVIEW_REQUESTED');
      await partnerPage.getByRole('textbox', { name: 'Write a comment...', exact: true }).fill(comment);
      await partnerPage.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(partnerPage.getByText(comment, { exact: true })).toBeVisible();
      await partnerPage.reload();
      await expect(partnerPage.getByText(comment, { exact: true })).toBeVisible();
      const after = await loadRequest(page, requestId);
      expect(after.details.status).toBe('REVIEW_REQUESTED');
      expect(after.details.statusHistory).toEqual(before.details.statusHistory);
      await expect(status(page, requestId, 'Review requested')).toBeVisible();
      await test.info().attach('comment-persisted-status-unchanged', {
        body: await partnerPage.screenshot(), contentType: 'image/png',
      });
    });
    await test.step('Request Revision changes the request to REVISION_REQUESTED', async () => {
      const decision = partnerPage.getByRole('region', { name: 'Final case decision', exact: true });
      await decision.getByRole('combobox', { name: /^Revision reason/ })
        .selectOption({ label: 'Dimensions or thickness' });
      await decision.getByRole('textbox', { name: 'Revision memo or optional approval comment', exact: true })
        .fill(`${caseCode}: Please increase the dimensions to 12 mm.`);
      await decision.getByRole('button', { name: 'Request revision', exact: true }).click();
      const confirmation = partnerPage.getByRole('alertdialog', { name: 'Request a design revision?', exact: true });
      await confirmation.getByRole('button', { name: 'Request revision', exact: true }).click();
      await expect(confirmation).toBeHidden();
      const request = await loadRequest(page, requestId);
      expect(request.details.status).toBe('REVISION_REQUESTED');
      await expect(status(page, requestId, 'Revision requested')).toBeVisible();
      await partnerPage.reload();
      const sharedCard = partnerPage.getByRole('article').filter({
        has: partnerPage.getByRole('button', { name: /^v1 .*Design result Shared/ }),
      });
      await expect(sharedCard.getByText('Revision requested', { exact: true })).toBeVisible();
      await expect(partnerPage.getByText(comment, { exact: true })).toBeVisible();
      await test.info().attach('revision-requested', { body: await partnerPage.screenshot(), contentType: 'image/png' });
      const evidence = { requestId, commentPersisted: true, statusAfterComment: 'REVIEW_REQUESTED',
        statusAfterRevision: request.details.status, revisionReason: 'Dimensions or thickness' };
      await test.info().attach('feedback-results', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      console.log(JSON.stringify(evidence));
    });
  } finally {
    await hospitalContext.close();
  }
});
