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

// TC-MG-011: Use an independent synthetic request to verify dispatch gating and hospital notification.
test('TC-MG-011: Dispatch requires completed production and notifies the hospital', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-MG-011-${randomUUID().slice(0, 8)}`;
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
      async function openProduction() {
        await manager.getByRole('button', { name: 'Update production', exact: true }).click();
        await manager
          .getByRole('dialog', { name: 'Production details', exact: true })
          .getByRole('button', { name: 'Edit', exact: true })
          .click();
      }
      const production = manager.getByRole('dialog', { name: 'Cranial · Titanium', exact: true });
      await operations();
      await test.step('Dispatch is unavailable before production DONE', async () => {
        await openProduction();
        await production
          .getByRole('combobox', { name: 'Production status*', exact: true })
          .selectOption('IN_PRODUCTION');
        await production.getByRole('button', { name: 'Save production', exact: true }).click();
        await expect(production).toBeHidden();
        const before = await operations();
        expect(before.productionStatus).toBe('IN_PRODUCTION');
        expect(before.shipmentStatus).toBe('PENDING');
        await expect(
          manager.getByText('Next: Mark production Done with a lot no. to unlock shipping.', {
            exact: true,
          }),
        ).toBeVisible();
        await expect(dispatch).toHaveCount(0);
        expect((await openCounselorRequest(page, requestId)).details.status).toBe(
          'PRODUCTION_HANDOFF',
        );
        await test.info().attach('dispatch-blocked-before-done', {
          body: await manager.screenshot(),
          contentType: 'image/png',
        });
      });
      await test.step('Complete synthetic production and record the required pre-shipment call check', async () => {
        await openProduction();
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
      await test.step('Hospital receives the shipment notification for this request', async () => {
        const [notificationsBody] = await Promise.all([
          waitForGraphqlResponse(partnerPage, 'Notifications').then((response) => response.json()),
          partnerPage.goto('/notifications'),
        ]);
        expect(notificationsBody.errors).toBeUndefined();
        await expect(partnerPage.getByText('Loading notifications', { exact: true })).toBeHidden();
        const shipmentNoticeIndex = notificationsBody.data.notifications.findIndex(
          (entry: { title: string; requestNo: string }) =>
            entry.title === 'Shipment dispatched' && entry.requestNo === requestId,
        );
        expect(shipmentNoticeIndex).toBeGreaterThanOrEqual(0);
        const shipmentNotice = notificationsBody.data.notifications[shipmentNoticeIndex];
        expect(shipmentNotice).toMatchObject({
          requestNo: requestId,
          requestStatus: 'SHIPPED',
          viewerOwnsRequest: true,
          body: 'Your request has been shipped.',
        });
        // Notification cards omit the request number from their visible text.
        // The API above verifies request ownership/status, while the newest
        // matching rendered card is the shipment event created by this test.
        const notification = partnerPage
          .getByRole('article')
          .filter({
            has: partnerPage.getByRole('heading', { name: 'Shipment dispatched', exact: true }),
          })
          .filter({ hasText: 'Your request has been shipped.' })
          .first();
        await expect(notification).toBeVisible();
        await expect(notification).toContainText('Your request has been shipped.');
        await test.info().attach('hospital-shipment-notification', {
          body: await notification.innerText(),
          contentType: 'text/plain',
        });
        await test.info().attach('hospital-notified', {
          body: await partnerPage.screenshot(),
          contentType: 'image/png',
        });
        const requestUrl = new RegExp(`/partner/requests/${requestId}$`);
        const samePageNavigation = expect(partnerPage)
          .toHaveURL(requestUrl, { timeout: 15_000 })
          .then(() => partnerPage)
          .catch(() => null);
        const popupNavigation = partnerPage
          .waitForEvent('popup', { timeout: 15_000 })
          .catch(() => null);
        const [opened, requestPage] = await Promise.all([
          waitForGraphqlResponse(partnerPage, 'MarkNotificationRead').then((response) =>
            response.json(),
          ),
          notification.getByRole('button', { name: 'Open request', exact: true }).click(),
          Promise.race([samePageNavigation, popupNavigation]),
        ]);
        expect(opened.errors).toBeUndefined();
        const destination = requestPage ?? partnerPage;
        await expect(destination).toHaveURL(requestUrl, { timeout: 15_000 });
        await expect(requestStatus(destination, requestId, 'Shipped')).toBeVisible();
      });
      console.log(
        JSON.stringify({ requestId, carrier, trackingNumber, shipDate, result: 'PASSED' }),
      );
    } finally {
      await managerContext.close();
    }
  } finally {
    await hospitalContext.close();
  }
});
