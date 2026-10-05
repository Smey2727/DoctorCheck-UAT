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

// TC-CS-006: Each run shares its own synthetic design with its hospital owner.
test('TC-CS-006: Counselor can share a revision and notify the hospital', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-CS-006-${randomUUID().slice(0, 8)}`;
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
    await test.step('Share revision with hospital', async () => {
      await expect(async () => {
        await loadRequest(page, requestId, true);
        await expect(page.getByRole('button', { name: 'Review and share v1', exact: true })).toBeEnabled({ timeout: 1000 });
      }).toPass({ timeout: 60_000, intervals: [1000, 2000, 5000] });
      await page.getByRole('button', { name: 'Review and share v1', exact: true }).click();
      const generate = page.getByRole('dialog', { name: 'Generate design document', exact: true });
      await generate.getByRole('textbox', { name: 'Counselor review note for partner', exact: true })
        .fill(`${caseCode}: Please review the first synthetic design revision.`);
      await generate.getByRole('button', { name: 'Generate and preview', exact: true }).click();
      await expect(generate).toBeHidden();
      const preview = page.getByRole('dialog', { name: 'Design-Result Document print view', exact: true });
      await expect(preview).toContainText(`${caseCode}-design.stl`);
      await preview.getByRole('checkbox', { name: /^I reviewed this exact document/ }).check();
      await preview.getByRole('button', { name: 'Share design with partner', exact: true }).click();
      await expect(preview).toBeHidden();
      const request = await loadRequest(page, requestId);
      expect(request.details.status).toBe('REVIEW_REQUESTED');
      await expect(status(page, requestId, 'Review requested')).toBeVisible();
    });
    await test.step('Hospital receives notification and can view the shared revision', async () => {
      const partnerPage = await hospitalContext.newPage();
      await partnerPage.goto('/notifications');
      const notification = partnerPage.getByRole('article').filter({ hasText: requestId })
        .filter({ has: partnerPage.getByRole('heading', { name: 'Design result shared', exact: true }) });
      await expect(notification).toHaveCount(1);
      await expect(notification.getByText(`A design result is ready for your review on ${requestId}.`, { exact: true }))
        .toBeVisible();
      await expect(notification.getByRole('button', { name: 'Review design result', exact: true })).toBeVisible();
      await partnerPage.goto(`/partner/requests/${requestId}`);
      await expect(status(partnerPage, requestId, 'Review requested')).toBeVisible();
      await partnerPage.getByRole('button', { name: /^Files & 3D,/ }).click();
      await expect(partnerPage.getByRole('heading', { name: 'Files & 3D deliverables', exact: true })).toBeVisible();
      await expect(partnerPage.getByText(`${caseCode}-design.stl · v1`, { exact: true })).toBeVisible();
      await expect(partnerPage.getByRole('img', { name: 'Design result preview', exact: true })).toBeVisible();
    });
  } finally {
    await hospitalContext.close();
  }
});

