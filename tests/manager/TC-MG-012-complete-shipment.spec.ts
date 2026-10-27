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

// TC-MG-012: Use an independent synthetic request to verify shipment completion.
test('TC-MG-012: Complete shipment changes Shipment and Request from SHIPPED to COMPLETED', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-MG-012-${randomUUID().slice(0, 8)}`;
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
      const dispatch = manager.getByRole('button', { name: 'Record shipment', exact: true });
      const production = manager.getByRole('dialog', { name: 'Cranial · Titanium', exact: true });
      await operations();
      await test.step('Complete synthetic production and record the required pre-shipment call check', async () => {
        await manager.getByRole('button', { name: 'Update production', exact: true }).click();
        await manager
          .getByRole('dialog', { name: 'Production details', exact: true })
          .getByRole('button', { name: 'Edit', exact: true })
          .click();
        await production
          .getByRole('combobox', { name: 'Production status*', exact: true })
          .selectOption('DONE');
        await production.getByRole('textbox', { name: /^Lot number/ }).fill(`${caseCode}-UAT-ONLY`);
        await production.getByRole('button', { name: 'Save production', exact: true }).click();
        await expect(production).toBeHidden();
        await manager.getByRole('button', { name: 'Log partner call', exact: true }).click();
        const call = manager.getByRole('dialog', { name: /^Log partner call/ });
        await call
          .getByRole('textbox', { name: 'Spoke with*', exact: true })
          .fill('Synthetic UAT contact - no real call');
        await call.getByRole('radio', { name: 'OK to ship', exact: true }).check();
        await call
          .getByRole('textbox', { name: 'Note', exact: true })
          .fill(`${caseCode}: Simulated check only. Do not ship.`);
        await call.getByRole('button', { name: 'Log call', exact: true }).click();
        await expect(call).toBeHidden();
        expect((await operations()).productionStatus).toBe('DONE');
      });
      const carrier = 'UAT simulation - do not ship';
      const trackingNumber = `${caseCode}-NOT-A-SHIPMENT`;
      const shipDate = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      await test.step('Dispatch with carrier, tracking number and ship date', async () => {
        await expect(dispatch).toBeEnabled();
        await dispatch.click();
        const shipment = manager.getByRole('dialog', { name: /^Record shipment/ });
        await shipment.getByRole('textbox', { name: 'Carrier*', exact: true }).fill(carrier);
        await shipment
          .getByRole('textbox', { name: 'Tracking number', exact: true })
          .fill(trackingNumber);
        await shipment.getByLabel(/^Ship date/).fill(shipDate);
        await shipment.getByRole('button', { name: 'Record shipment', exact: true }).click();
        await expect(shipment).toBeHidden();
        const saved = await operations();
        await test.info().attach('saved-shipment', {
          body: JSON.stringify({ requestId, shipDate, ...saved }, null, 2),
          contentType: 'application/json',
        });
        expect(saved).toMatchObject({
          shipmentStatus: 'SHIPPED',
          carrier,
          trackingNo: trackingNumber,
          shipDate,
        });
        expect((await openCounselorRequest(page, requestId)).details.status).toBe('SHIPPED');
        await expect(manager.getByText(carrier, { exact: true })).toBeVisible();
        await expect(manager.getByText(trackingNumber, { exact: true })).toBeVisible();
        await test.info().attach('shipment-shipped', {
          body: await manager.screenshot(),
          contentType: 'image/png',
        });
      });
      await test.step('Complete the shipment and verify both persisted statuses', async () => {
        await manager.getByRole('button', { name: 'Mark complete', exact: true }).click();
        const confirmation = manager.getByRole('alertdialog', {
          name: 'Complete this shipment?',
          exact: true,
        });
        await confirmation.getByRole('button', { name: 'Mark complete', exact: true }).click();
        await expect(confirmation).toBeHidden();
        const completedShipment = await operations();
        expect(completedShipment).toMatchObject({
          requestNo: requestId,
          shipmentStatus: 'COMPLETED',
          carrier,
          trackingNo: trackingNumber,
          shipDate,
        });
        const completedRequest = await openCounselorRequest(page, requestId);
        expect(completedRequest.details.status).toBe('COMPLETED');
        await expect(requestStatus(page, requestId, 'Completed')).toBeVisible();
        await expect(
          manager.getByRole('button', { name: 'Mark complete', exact: true }),
        ).toHaveCount(0);
        await test.info().attach('completed-shipment-and-request', {
          body: JSON.stringify(
            {
              requestNo: requestId,
              requestStatus: completedRequest.details.status,
              operations: completedShipment,
            },
            null,
            2,
          ),
          contentType: 'application/json',
        });
        await test.info().attach('shipment-completed', {
          body: await manager.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
      });
      console.log(
        JSON.stringify({
          requestId,
          shipmentStatus: 'COMPLETED',
          requestStatus: 'COMPLETED',
          result: 'PASSED',
        }),
      );
    } finally {
      await managerContext.close();
    }
  } finally {
    await hospitalContext.close();
  }
});
