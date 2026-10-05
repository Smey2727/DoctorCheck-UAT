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

// TC-CS-017: Hospital request content is read-only for the counselor during design.
test('TC-CS-017: Counselor cannot edit Hospital request data during design', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-CS-017-${randomUUID().slice(0, 8)}`;
    await signIn(hospitalPage, USERS.hospital);
    const requestId = await createHospitalReworkRequest(hospitalPage, caseCode, {
      ...syntheticCtRoundTwo, name: `${caseCode}-ct.zip`,
    });
    test.info().annotations.push({ type: 'request', description: requestId });
    const billingAccount = (target: Page) => target.getByRole('term')
      .filter({ hasText: /^Billing account$/ }).locator('xpath=following-sibling::dd[1]');
    await expect(billingAccount(hospitalPage)).toHaveText('Direct partner billing');
    const originalBilling = await billingAccount(hospitalPage).innerText();
    await hospitalPage.close();
    await signIn(page, USERS.counselor);
    const submitted = await loadRequest(page, requestId);
    expect(submitted.details.status).toBe('SUBMITTED');
    expect(submitted.details).toMatchObject({
      product: 'Cranium', material: 'Titanium', priceSizeBucketLabel: 'Small',
      financialAgencyUserId: null, surgeryType: 'Cranioplasty', surgeon: 'Dr. UAT Test',
    });
    const hospitalFields = ['detailTypeId', 'product', 'productCategory', 'material', 'priceSizeBucketLabel',
      'financialAgencyUserId', 'agencyNames', 'surgeryDate', 'surgeryType', 'surgeon',
      'requester', 'patientCode', 'caseDescription', 'fixationHoles', 'optionValues'];
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
    const initial = await loadRequest(page, requestId);
    expect(initial.details.status).toBe('PRODUCT_DESIGN');
    await expect(status(page, requestId, 'Product design')).toBeVisible();
    await test.step('Hospital submission is displayed without edit or save controls', async () => {
      await page.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
      await expect(page.getByRole('heading', { name: 'Submission summary', exact: true })).toBeVisible();
      await expect(page.getByText(/^submitted values .* locked after review$/)).toBeVisible();
      const field = (label: string) => page.getByRole('term').filter({ hasText: new RegExp(`^${label}$`) })
        .locator('xpath=following-sibling::dd[1]');
      await expect(field('Product')).toHaveText('Cranium / Titanium');
      await expect(field('Surgeon')).toHaveText(submitted.details.surgeon);
      await expect(field('Requester')).toHaveText(submitted.details.requester);
      await expect(field('Patient')).toHaveText(caseCode);
      await expect(field('Surgery type')).toHaveText(submitted.details.surgeryType);
      const [year, month, day] = submitted.details.surgeryDate.split('-').map(Number);
      await expect(field('Surgery date')).toHaveText(`${month}/${day}/${year}`);
      // These are plain text definitions, not form fields. This also catches
      // newly added size/billing editors, even if they have different labels.
      await expect(page.locator('main').locator('input:not([type="hidden"]), select, textarea, [contenteditable="true"]')).toHaveCount(0);
      await expect(page.locator('main').getByRole('button', { name: /^(?:edit|save|update|change)(?:\s|$)/i })).toHaveCount(0);
      await expect(page.locator('main').getByRole('link', { name: /^(?:edit|save|update|change)(?:\s|$)/i })).toHaveCount(0);
    });
    await test.step('Reload and verify hospital content and billing remain unchanged', async () => {
      const persisted = await loadRequest(page, requestId);
      expect(persisted.details.status).toBe('PRODUCT_DESIGN');
      expect(persisted.details.statusHistory).toEqual(initial.details.statusHistory);
      for (const key of hospitalFields) {
        expect(persisted.details[key], `Hospital field ${key} must remain unchanged`).toEqual(submitted.details[key]);
      }
      const ownerPage = await hospitalContext.newPage();
      await ownerPage.goto(`/partner/requests/${requestId}`);
      await expect(ownerPage.getByRole('heading', { name: requestId, exact: true })).toBeVisible();
      await expect(billingAccount(ownerPage)).toHaveText(originalBilling);
    });
  } finally { await hospitalContext.close(); }
});

