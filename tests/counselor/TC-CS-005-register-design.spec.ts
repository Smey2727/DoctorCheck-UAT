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

async function signInCounselor(page: Page, login: string, designEnabled: boolean) {
  const me = await signIn(page, login);
  expect(me).toMatchObject({ role: 'COUNSELOR', designEnabled, mustChangePassword: false });
  return me;
}

async function reassign(page: Page, requestId: string, displayName: string) {
  await loadRequest(page, requestId);
  await page.getByRole('button', { name: 'Reassign', exact: true }).click();
  const counselor = page.getByRole('combobox', { name: /^New counselor/ });
  await counselor.selectOption({ label: displayName });
  await counselor.locator('xpath=ancestor::form[1]').getByRole('button', { name: 'Reassign', exact: true }).click();
  await expect(counselor).toBeHidden();
}

// TC-CS-005: Review-only counselors cannot register a design; design-enabled
// counselors can create Revision 1 and a DESIGN_RESULT in PRODUCT_DESIGN.
test('TC-CS-005: Design registration blocks normal counselors and permits design-enabled counselors', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  const designerContext = await browser.newContext({ baseURL });
  try {
    const caseCode = `TC-CS-005-${randomUUID().slice(0, 8)}`;
    const hospitalPage = await hospitalContext.newPage();
    await signIn(hospitalPage, USERS.hospital);
    const requestId = await createHospitalReworkRequest(hospitalPage, caseCode, {
      ...syntheticCtRoundTwo, name: `${caseCode}-ct.zip`,
    });
    test.info().annotations.push({ type: 'request', description: requestId });
    await hospitalPage.close();

    const reviewer = await signInCounselor(page, USERS.counselorReview, false);
    await test.step('Review-only counselor prepares a fresh request for design', async () => {
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
      const request = await loadRequest(page, requestId, true);
      expect(request.details.status).toBe('CONVERTING_3D');
      expect(request.details.allowedActions).not.toContain('REGISTER_DESIGN_FILE');
      await expect(page.getByText('Read-only audit mode', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Upload converted 3D', exact: true })).toHaveCount(0);
    });

    const designerPage = await designerContext.newPage();
    const designer = await signInCounselor(designerPage, USERS.counselor, true);
    await test.step('Design-enabled counselor prepares the converted model', async () => {
      await reassign(page, requestId, designer.displayName);
      await loadRequest(designerPage, requestId, true);
      const upload = designerPage.getByRole('button', { name: 'Upload converted 3D', exact: true });
      await expect(upload).toBeVisible();
      const fileChooser = designerPage.waitForEvent('filechooser');
      await upload.click();
      const [response] = await Promise.all([
        designerPage.waitForResponse(response => response.url().endsWith('/graphql')
          && response.request().postDataJSON()?.operationName === 'RegisterDesignFile'),
        (await fileChooser).setFiles(syntheticModel(`${caseCode}-converted.stl`)),
      ]);
      const body = await response.json();
      expect(body.errors).toBeUndefined();
      await expect(async () => {
        const request = await loadRequest(designerPage, requestId, true);
        expect(request.details.allowedActions).toContain('REGISTER_DESIGN_FILE');
        await expect(designerPage.getByRole('button', { name: 'Upload design result', exact: true })).toBeVisible();
      }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
      await reassign(designerPage, requestId, reviewer.displayName);
    });

    await test.step('Normal counselor has no design registration permission or control', async () => {
      const request = await loadRequest(page, requestId, true);
      expect(request.counselorUserId).toBe(reviewer.id);
      expect(request.details.status).toBe('PRODUCT_DESIGN');
      expect(request.details.allowedActions).not.toContain('REGISTER_DESIGN_FILE');
      await expect(page.getByText('Read-only audit mode', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Upload design result$/i })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Register design$/i })).toHaveCount(0);
    });

    await test.step('Assign the same request to the design-enabled counselor', async () => {
      await reassign(page, requestId, designer.displayName);
    });

    await test.step('Design-enabled counselor registers the first design revision', async () => {
      await expect(async () => {
        const request = await loadRequest(designerPage, requestId, true);
        expect(request.details.allowedActions).toContain('REGISTER_DESIGN_FILE');
        await expect(designerPage.getByRole('button', { name: 'Upload design result', exact: true })).toBeVisible();
      }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
      await designerPage.getByRole('button', { name: 'Upload design result', exact: true }).click();
      const dialog = designerPage.getByRole('dialog', { name: 'Upload design result', exact: true });
      await dialog.getByRole('spinbutton', { name: 'Width (mm)*', exact: true }).fill('10');
      await dialog.getByRole('spinbutton', { name: 'Height (mm)*', exact: true }).fill('10');
      await dialog.getByRole('spinbutton', { name: 'Thickness (mm)*', exact: true }).fill('10');
      const designName = `${caseCode}-design.stl`;
      await dialog.locator('input[type="file"]').setInputFiles(syntheticModel(designName));
      const [response] = await Promise.all([
        designerPage.waitForResponse(response => response.url().endsWith('/graphql')
          && response.request().postDataJSON()?.operationName === 'RegisterDesignFile'),
        dialog.getByRole('button', { name: 'Upload design result', exact: true }).click(),
      ]);
      const body = await response.json();
      expect(body.errors).toBeUndefined();
      expect(body.data.registerDesignFile).toMatchObject({ requestNo: requestId, status: 'PRODUCT_DESIGN' });
      await expect(dialog).toBeHidden();
      const [filesResponse, persistedRequest] = await Promise.all([
        designerPage.waitForResponse(response => response.url().endsWith('/graphql')
          && response.request().postDataJSON()?.operationName === 'DesignFiles'),
        loadRequest(designerPage, requestId, true),
      ]);
      expect(persistedRequest.details.status).toBe('PRODUCT_DESIGN');
      const filesBody = await filesResponse.json();
      expect(filesBody.errors).toBeUndefined();
      const designs = filesBody.data.designFiles.filter((file: { category: string }) => file.category === 'DESIGN_RESULT');
      expect(designs).toHaveLength(1);
      expect(designs[0]).toMatchObject({
        version: 1,
        latest: true,
        uploadedByUserId: designer.id,
        file: { originalName: designName, status: 'AVAILABLE' },
        specification: {
          product: 'Cranium', material: 'Titanium',
          dimensions: { widthMm: '10.000', heightMm: '10.000', thicknessMm: '10.000' },
        },
      });
      await expect(designerPage.getByRole('button', { name: /^v1 - Design result / }).filter({ hasText: designName }))
        .toBeVisible();
      await expect(designerPage.getByRole('region', { name: 'Status flow queue', exact: true })
        .getByRole('button', { name: 'Product design', exact: true })).toBeVisible();
    });
  } finally {
    await hospitalContext.close();
    await designerContext.close();
  }
});
