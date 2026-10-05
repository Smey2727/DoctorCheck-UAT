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

test('TC-HP-016: Hospital receives rework and design-share notifications linking to the affected request', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  const hospitalContext = await browser.newContext({ baseURL });
  hospitalContext.setDefaultTimeout(15_000);
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-HP-016-${randomUUID().slice(0, 8)}`;
    await signIn(hospitalPage, 'hospital.c@saerosoft.com');
    const requestId = await createHospitalReworkRequest(hospitalPage, caseCode, {
      ...syntheticCtRoundTwo, name: `${caseCode}-ct.zip`,
    });
    test.info().annotations.push({ type: 'request', description: requestId });

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
      const reason = `${caseCode}: Clarify the synthetic case description; CT is already readable.`;
      await hospitalPage.goto('/notifications');
      await page.getByRole('button', { name: 'Request rework', exact: true }).click();
      await page.getByRole('textbox', { name: 'Explain what the partner needs to fix', exact: true }).fill(reason);
      await page.getByRole('button', { name: 'Send rework request', exact: true }).click();
      await expect(status(page, requestId, 'Rework requested')).toBeVisible();
      await hospitalPage.reload();
      const reworkNotification = hospitalPage.getByRole('article').filter({
        has: hospitalPage.getByRole('heading', { name: `Supplement requested for ${requestId}`, exact: true }),
      });
      await expect(reworkNotification).toHaveCount(1);
      await expect(reworkNotification.getByText(reason, { exact: true })).toBeVisible();
      await test.info().attach('rework-notification', { body: await hospitalPage.screenshot(), contentType: 'image/png' });
      await reworkNotification.getByRole('button', { name: 'Update and resubmit', exact: true }).click();
      await expect(hospitalPage).toHaveURL(new RegExp(`/partner/requests/${requestId}/resubmit$`));
      const reworkLinkUrl = hospitalPage.url();
      await test.info().attach('rework-notification-link', { body: JSON.stringify({ requestId, destination: reworkLinkUrl }), contentType: 'application/json' });
      await hospitalPage.goto(`/partner/requests/${requestId}`);
      await expect(status(hospitalPage, requestId, 'Rework requested')).toBeVisible();
      await hospitalPage.getByRole('link', { name: 'Fix & resubmit', exact: true }).click();
      await hospitalPage.getByRole('textbox', { name: 'Case description', exact: true })
        .fill(`${caseCode}: Clarified synthetic case details for the second submission. No patient data.`);
      await hospitalPage.getByRole('button', { name: 'Resubmit request', exact: true }).first().click();
      const resubmit = hospitalPage.getByRole('alertdialog');
      await resubmit.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
      await resubmit.getByRole('button', { name: 'Resubmit request', exact: true }).click();
      await expect(status(hospitalPage, requestId, 'Submitted')).toBeVisible();
      await page.reload();
      await expect(status(page, requestId, 'Submitted')).toBeVisible();
      await page.getByRole('button', { name: 'Start review', exact: true }).click();
      const roundTwoNote = page.getByRole('textbox', { name: 'Optional note for the status history', exact: true });
      await roundTwoNote.fill(`${caseCode}: Source review after clarification.`);
      await roundTwoNote.locator('..').getByRole('button', { name: 'Start review', exact: true }).click();
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
    await test.step('Hospital receives the design-share notification and follows it to the shared design', async () => {
      await hospitalPage.goto('/notifications');
      const notification = hospitalPage.getByRole('article').filter({ hasText: requestId }).filter({
        has: hospitalPage.getByRole('heading', { name: 'Design result shared', exact: true }),
      });
      await expect(notification).toHaveCount(1);
      await expect(notification.getByText(`A design result is ready for your review on ${requestId}.`, { exact: true })).toBeVisible();
      await test.info().attach('design-share-notification', { body: await hospitalPage.screenshot(), contentType: 'image/png' });
      await notification.getByRole('button', { name: 'Review design result', exact: true }).click();
      await expect(hospitalPage).toHaveURL(new RegExp(`/requests/${requestId}/model(?:\\?.*)?$`));
      const design = hospitalPage.getByRole('article').filter({
        has: hospitalPage.getByRole('button', { name: /^v1 .*Design result Shared/ }),
      });
      await expect(design).toContainText(`${caseCode}-design-v1.stl`);
      await test.info().attach('notification-opens-shared-design', { body: await hospitalPage.screenshot(), contentType: 'image/png' });
      await hospitalPage.goto('/notifications');
      await expect(hospitalPage.getByRole('heading', { name: `Supplement requested for ${requestId}`, exact: true })).toBeVisible();
      await expect(notification).toHaveCount(1);
      const result = { requestId, reworkNotification: true, reworkLinkVerified: true,
        designShareNotification: true, designShareLinkVerified: true, hospitalSessionStayedActive: true,
        emailDeliveryVerified: false };
      await test.info().attach('notification-results', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
      test.info().annotations.push({ type: 'scope', description: 'In-app delivery and request navigation verified. Email inbox delivery is not verified.' });
      console.log(JSON.stringify(result));
    });
  } finally {
    await hospitalContext.close();
  }
});
