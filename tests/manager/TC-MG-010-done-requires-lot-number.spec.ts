import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { waitForGraphqlResponse } from '../helpers/graphql';
import {
  requestStatus,
  openCounselorRequest,
  uploadDesign,
  shareDesign,
} from '../helpers/design-workflow';
import { signIn, USERS } from '../helpers/auth';
import { createHospitalReworkRequest } from '../helpers/requests';
import { syntheticCtRoundTwo } from '../helpers/synthetic-ct';
import { syntheticModel } from '../helpers/synthetic-model';

// TC-MG-010: Use an independent synthetic request to verify the production lot-number gate.
test('TC-MG-010: Production DONE requires a lot number', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-MG-010-${randomUUID().slice(0, 8)}`;
    await signIn(hospitalPage, USERS.hospital);
    const requestId = await createHospitalReworkRequest(hospitalPage, caseCode, {
      ...syntheticCtRoundTwo,
      name: `${caseCode}-ct.zip`,
    });
    test.info().annotations.push({ type: 'request', description: requestId });
    await hospitalPage.close();
    await signIn(page, USERS.counselor);
    await test.step('Prepare a fresh request and accept its sources', async () => {
      await page.goto('/counselor/requests');
      await page.getByRole('searchbox', { name: /^Search request no\./ }).fill(requestId);
      const row = page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: requestId, exact: true }) });
      const claim = row.getByRole('button', { name: 'Claim', exact: true });
      await claim.click();
      await expect(claim).toBeHidden();
      await page.goto(`/counselor/requests/${requestId}`);
      await page.getByRole('button', { name: 'Start review', exact: true }).click();
      const note = page.getByRole('textbox', {
        name: 'Optional note for the status history',
        exact: true,
      });
      await note.fill(`${caseCode}: source review`);
      await note.locator('..').getByRole('button', { name: 'Start review', exact: true }).click();
      await expect(requestStatus(page, requestId, 'In review')).toBeVisible();
      await expect(async () => {
        await page.reload();
        await page.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
        await expect(
          page.getByRole('button', { name: 'Accept latest round', exact: true }),
        ).toBeEnabled({ timeout: 1_000 });
      }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
      await page.getByRole('button', { name: 'Accept latest round', exact: true }).click();
      await page.getByRole('button', { name: /^Enter design stage$/i }).click();
      await expect(requestStatus(page, requestId, 'Converting 3D')).toBeVisible();
    });
    await test.step('Register converted model', async () => {
      await openCounselorRequest(page, requestId, true);
      const upload = page.getByRole('button', { name: 'Upload converted 3D', exact: true });
      await expect(upload).toBeVisible();
      const fileChooser = page.waitForEvent('filechooser');
      await upload.click();
      const [response] = await Promise.all([
        waitForGraphqlResponse(page, 'RegisterDesignFile'),
        (await fileChooser).setFiles(syntheticModel(`${caseCode}-converted.stl`)),
      ]);
      const body = await response.json();
      expect(body.errors).toBeUndefined();
      await expect(async () => {
        const request = await openCounselorRequest(page, requestId, true);
        expect(request.details.allowedActions).toContain('REGISTER_DESIGN_FILE');
        await expect(
          page.getByRole('button', { name: 'Upload design result', exact: true }),
        ).toBeVisible();
      }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
    });
    await test.step('Register and share Revision 1', async () => {
      await uploadDesign(page, requestId, caseCode, 1, 10);
      await shareDesign(page, requestId, caseCode, 1);
    });
    await page.getByRole('button', { name: 'Production handoff', exact: true }).click();
    const blocked = await openCounselorRequest(page, requestId);
    expect(blocked.details.status).toBe('REVIEW_REQUESTED');
    expect(blocked.details.allowedActions).not.toContain('HANDOFF_TO_PRODUCTION');
    await expect(requestStatus(page, requestId, 'Review requested')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Handoff to production', exact: true }),
    ).toHaveCount(0);
    const partnerPage = await hospitalContext.newPage();
    await partnerPage.goto(`/requests/${requestId}/model`);
    const decision = partnerPage.getByRole('region', { name: 'Final case decision', exact: true });
    await expect(decision).toContainText('This decision applies to v1.');
    await decision.getByRole('button', { name: 'Approve design and price', exact: true }).click();
    const approval = partnerPage.getByRole('alertdialog', {
      name: 'Approve this design?',
      exact: true,
    });
    await approval.getByRole('checkbox', { name: /^I reviewed/ }).check();
    await approval.getByRole('button', { name: 'Approve design and price', exact: true }).click();
    await expect(approval).toBeHidden();
    const approved = await openCounselorRequest(page, requestId);
    expect(approved.details.status).toBe('DESIGN_CONFIRMED');
    expect(approved.details.allowedActions).toContain('HANDOFF_TO_PRODUCTION');
    await page.getByRole('button', { name: 'Handoff to production', exact: true }).click();
    const handoff = page.getByRole('alertdialog', {
      name: 'Send this request to production?',
      exact: true,
    });
    await handoff.getByRole('checkbox', { name: /^I confirm the approved design/ }).check();
    await handoff.getByRole('button', { name: 'Handoff to production', exact: true }).click();
    await expect(handoff).toBeHidden();
    const managerContext = await browser.newContext({ baseURL });
    try {
      const manager = await managerContext.newPage();
      await signIn(manager, USERS.manager);
      async function operations() {
        const [response] = await Promise.all([
          waitForGraphqlResponse(manager, 'RequestOperations'),
          manager.goto(`/manager/requests/${requestId}`),
        ]);
        const body = await response.json();
        expect(body.errors).toBeUndefined();
        return body.data.requestOperations;
      }
      expect((await openCounselorRequest(page, requestId)).details.status).toBe(
        'PRODUCTION_HANDOFF',
      );
      expect((await operations()).productionStatus).toBe('PENDING');
      async function openProduction() {
        await manager.getByRole('button', { name: 'Update production', exact: true }).click();
        await manager
          .getByRole('dialog', { name: 'Production details', exact: true })
          .getByRole('button', { name: 'Edit', exact: true })
          .click();
      }
      const dialog = manager.getByRole('dialog', { name: 'Cranial · Titanium', exact: true });
      const productionStatus = dialog.getByRole('combobox', {
        name: 'Production status*',
        exact: true,
      });
      const lot = dialog.getByRole('textbox', { name: /^Lot number/ });
      const save = dialog.getByRole('button', { name: 'Save production', exact: true });
      await test.step('Save IN_PRODUCTION without a lot number and verify persistence', async () => {
        await openProduction();
        await productionStatus.selectOption('IN_PRODUCTION');
        await lot.fill('');
        await save.click();
        await expect(dialog).toBeHidden();
        const saved = await operations();
        expect(saved.productionStatus).toBe('IN_PRODUCTION');
      });
      await test.step('DONE without a lot number is blocked and saved status is unchanged', async () => {
        await openProduction();
        await expect(lot).toHaveValue('');
        await productionStatus.selectOption('DONE');
        await lot.fill('');
        await save.click();
        await expect(dialog).toBeVisible();
        await expect(async () => {
          const invalid = await lot.evaluate((el: HTMLInputElement) => !el.validity.valid);
          expect(
            invalid || /lot number.*required|required.*lot number/i.test(await dialog.innerText()),
          ).toBe(true);
        }).toPass({ timeout: 10_000 });
        const validation = await lot.evaluate((el: HTMLInputElement) => ({
          required: el.required,
          valid: el.validity.valid,
          message: el.validationMessage,
        }));
        const dialogText = await dialog.innerText();
        await test.info().attach('missing-lot-validation', {
          body: JSON.stringify({ validation, dialogText }, null, 2),
          contentType: 'application/json',
        });
        await test.info().attach('done-without-lot-blocked', {
          body: await manager.screenshot(),
          contentType: 'image/png',
        });
        const saved = await operations();
        expect(saved.productionStatus).toBe('IN_PRODUCTION');
      });
      const lotNumber = `${caseCode}-UAT-ONLY`;
      await test.step('DONE with a lot number succeeds and persists', async () => {
        await openProduction();
        await expect(lot).toHaveValue('');
        await productionStatus.selectOption('DONE');
        await lot.fill(lotNumber);
        await save.click();
        await expect(dialog).toBeHidden();
        const saved = await operations();
        expect(saved.productionStatus).toBe('DONE');
        await openProduction();
        await expect(productionStatus).toHaveValue('DONE');
        await expect(lot).toHaveValue(lotNumber);
        await test.info().attach('saved-production', {
          body: JSON.stringify({ requestId, ...saved }, null, 2),
          contentType: 'application/json',
        });
        await test.info().attach('done-with-lot', {
          body: await manager.screenshot(),
          contentType: 'image/png',
        });
      });
      console.log(JSON.stringify({ requestId, lotNumber, result: 'PASSED' }));
    } finally {
      await managerContext.close();
    }
  } finally {
    await hospitalContext.close();
  }
});
