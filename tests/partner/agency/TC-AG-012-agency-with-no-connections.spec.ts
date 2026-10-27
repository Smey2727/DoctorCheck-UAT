import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { getAuthorizationHeaders, waitForGraphqlResponse } from '../../helpers/graphql';
import {
  requestStatus,
  openCounselorRequest,
  uploadDesign,
  shareDesign,
} from '../../helpers/design-workflow';
import { signIn, USERS } from '../../helpers/auth';
import { prepareHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';
import { syntheticModel } from '../../helpers/synthetic-model';

async function createAgencyOwnRequest(page: Page, caseCode: string) {
  await prepareHospitalReworkRequest(
    page,
    caseCode,
    {
      ...syntheticCtRoundTwo,
      name: `${caseCode}-synthetic-ct.zip`,
    },
    undefined,
    'PEEK',
  );
  await page
    .getByRole('textbox', { name: 'Hospital*', exact: true })
    .fill('TC-AG-012 Synthetic Hospital');
  await expect(
    page.getByText('Direct billing to this partner account', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/KRW\s*900,000(?:\.00)?/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
  const confirmation = page.getByRole('alertdialog', { name: 'Submit this request?', exact: true });
  await confirmation
    .getByRole('checkbox', { name: /^I reviewed the case details and files/ })
    .check();
  await confirmation.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page).toHaveURL(/\/partner\/requests\/REQ-\d{4}-\d+/);
  const requestId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByRole('heading', { name: requestId, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submitted', exact: true })).toBeVisible();
  return requestId;
}

async function createAgencyThree(manager: Page, agencyPage: Page, code: string) {
  const loginId = code.toLowerCase();
  const displayName = `Agency 3 ${code}`;
  const temporaryPassword = `Tmp!${randomUUID()}Aa1`;
  const privatePassword = `Own!${randomUUID()}Bb2`;
  await manager.goto('/manager/users');
  await manager.getByRole('button', { name: '+ New account', exact: true }).click();
  const dialog = manager.getByRole('dialog', { name: 'New account', exact: true });
  await dialog.getByRole('combobox', { name: 'Role*', exact: true }).selectOption('PARTNER');
  await dialog.getByRole('textbox', { name: 'Display name*', exact: true }).fill(displayName);
  await dialog.getByRole('textbox', { name: /^Login ID/ }).fill(loginId);
  await dialog.getByRole('textbox', { name: /^Temporary password\*/ }).fill(temporaryPassword);
  await dialog
    .getByRole('combobox', { name: 'Partner type*', exact: true })
    .selectOption({ label: 'Agency' });
  await dialog
    .getByRole('textbox', { name: 'Organization*', exact: true })
    .fill(`UAT ${displayName}`);
  await dialog
    .getByRole('textbox', { name: 'Phone / contact*', exact: true })
    .fill('010-0000-0000');
  await dialog.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(dialog).toBeHidden();
  test.info().annotations.push({ type: 'account', description: loginId });
  const initial = await signIn(agencyPage, loginId, temporaryPassword);
  expect(initial.mustChangePassword).toBe(true);
  await agencyPage.getByRole('textbox', { name: /^Current password\*/ }).fill(temporaryPassword);
  await agencyPage.getByRole('textbox', { name: /^New password\*/ }).fill(privatePassword);
  await agencyPage.getByRole('textbox', { name: /^Confirm new password\*/ }).fill(privatePassword);
  await agencyPage.getByRole('button', { name: 'Update password', exact: true }).click();
  await expect(agencyPage).toHaveURL(/\/login/);
  const user = await signIn(agencyPage, loginId, privatePassword);
  expect(user).toMatchObject({
    loginId,
    role: 'PARTNER',
    accountStatus: 'ACTIVE',
    mustChangePassword: false,
  });
  return { user, displayName };
}

async function verifyNoConnections(manager: Page, agencyId: string, displayName: string) {
  await manager.goto('/manager/agencies');
  await manager
    .getByRole('searchbox', { name: 'Search agency by name / login', exact: true })
    .fill(displayName);
  const [body] = await Promise.all([
    manager
      .waitForResponse(
        async (r) =>
          r.url().endsWith('/graphql') &&
          r.request().postDataJSON()?.operationName === 'Agency' &&
          (await r.json().catch(() => null))?.data?.agency?.id === agencyId,
      )
      .then((response) => response.json()),
    manager.getByRole('button', { name: new RegExp(`^${displayName} `) }).click(),
  ]);
  expect(body.errors).toBeUndefined();
  expect(body.data.agency.members).toHaveLength(0);
}

async function verifyOwnRequestsOnly(page: Page, requestIds: string[]) {
  const [body] = await Promise.all([
    waitForGraphqlResponse(page, 'Requests').then((response) => response.json()),
    page.goto('/partner/requests'),
  ]);
  expect(body.errors).toBeUndefined();
  expect(body.data.requests.totalCount).toBe(requestIds.length);
  expect(body.data.requests.items.map((r: any) => r.requestNo).sort()).toEqual(
    [...requestIds].sort(),
  );
  for (const id of requestIds) {
    await expect(page.locator(`a[href="/partner/requests/${id}"]`)).toBeVisible();
  }
  await test.info().attach('agency-own-requests-only', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
}

// TC-AG-012: Synthetic Agency own request; one login per role and no real shipment or payment.
test('TC-AG-012: Agency 3 with no Hospital connections submits at base price and sees only its own request and bill', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(15_000);
  const agencyContext = await browser.newContext({ baseURL });
  const managerContext = await browser.newContext({ baseURL });
  agencyContext.setDefaultTimeout(15_000);
  managerContext.setDefaultTimeout(15_000);
  try {
    const manager = await managerContext.newPage();
    await signIn(manager, USERS.manager);
    const agencyPage = await agencyContext.newPage();
    const caseCode = `TC-AG-012-${randomUUID().slice(0, 8)}`;
    const { user: agencyUser, displayName } = await createAgencyThree(
      manager,
      agencyPage,
      caseCode,
    );
    await verifyNoConnections(manager, agencyUser.id, displayName);
    // A new agency needs an explicit contract rule for every size. Zero
    // adjustment uses Standard price without adding any hospital membership.
    await manager.goto('/manager/pricing');
    await manager.getByRole('button', { name: 'Agency contract pricing', exact: true }).click();
    await Promise.all([
      waitForGraphqlResponse(manager, 'AgencyPricing'),
      manager.getByRole('button', { name: displayName, exact: true }).click(),
    ]);
    for (const size of ['Small', 'Medium', 'Large', 'Extra']) {
      await manager.getByRole('button', { name: '+ Add adjustment', exact: true }).click();
      await manager
        .getByRole('combobox', { name: 'Product item', exact: true })
        .selectOption({ label: 'Cranial' });
      await manager
        .getByRole('combobox', { name: 'Material', exact: true })
        .selectOption({ label: 'PEEK' });
      await manager
        .getByRole('combobox', { name: 'Size bucket', exact: true })
        .selectOption({ label: size });
      await manager
        .getByRole('combobox', { name: 'Type', exact: true })
        .selectOption({ label: 'Percent' });
      await manager.getByRole('textbox', { name: 'New adjustment value', exact: true }).fill('0');
      await manager.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(
        manager
          .getByRole('row')
          .filter({ has: manager.getByRole('cell', { name: size, exact: true }) }),
      ).toContainText('Cranial');
    }
    await verifyOwnRequestsOnly(agencyPage, []);
    const requestId = await createAgencyOwnRequest(agencyPage, caseCode);
    test.info().annotations.push({ type: 'request', description: requestId });
    await verifyOwnRequestsOnly(agencyPage, [requestId]);
    await agencyPage.close();
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
    const partnerPage = await agencyContext.newPage();
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
    {
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
      const production = manager.getByRole('dialog', { name: 'Cranial · PEEK', exact: true });
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

      await test.step('Issue the base-price bill directly to the Agency and verify it in Agency Bills', async () => {
        const [requestBody] = await Promise.all([
          waitForGraphqlResponse(manager, 'Request').then((response) => response.json()),
          operations(),
        ]);
        expect(requestBody.errors).toBeUndefined();
        const details = requestBody.data.request.details;
        expect(details).toMatchObject({
          requestNo: requestId,
          status: 'COMPLETED',
          financialAgencyUserId: null,
          priceCurrency: 'KRW',
        });
        expect(details.lines).toHaveLength(1);
        const line = details.lines[0];
        expect(line).toMatchObject({ product: 'Cranial', material: 'PEEK' });
        const selected = line.priceTable.options.find(
          (option: any) => option.id === line.priceTable.selectedOptionId,
        );
        expect(selected).toBeDefined();
        expect(selected.sizeBucketLabel).toBe('Small');
        expect(Number(selected.baseAmount)).toBe(900000);
        expect(Number(details.quotedPrice)).toBe(900000);
        expect(Number(selected.adjustmentPercent ?? 0)).toBe(0);
        expect(Number(selected.adjustmentAmount ?? 0)).toBe(0);
        const period = { year: Number(shipDate.slice(0, 4)), month: Number(shipDate.slice(5, 7)) };
        const [capture] = await Promise.all([
          waitForGraphqlResponse(manager, 'BillingSummary').then(async (r) => ({
            url: r.url(),
            query: r.request().postDataJSON(),
            headers: getAuthorizationHeaders(r),
            body: await r.json(),
          })),
          manager.getByRole('link', { name: /Billing row/ }).click(),
        ]);
        expect(capture.body.errors).toBeUndefined();
        async function savedBill() {
          const response = await manager.request.post(capture.url, {
            headers: capture.headers,
            data: { ...capture.query, variables: period },
          });
          expect(response.ok()).toBe(true);
          const body = await response.json();
          expect(body.errors).toBeUndefined();
          const group = body.data.billingSummary.directPartnerGroups.find((g: any) =>
            g.requests.some((r: any) => r.requestNo === requestId),
          );
          expect(group).toMatchObject({ billedToUserId: agencyUser.id, viaAgency: false });
          const invoice = group.requests.find((r: any) => r.requestNo === requestId);
          expect(Number(invoice.calculatedAmount)).toBe(900000);
          expect(invoice.currency).toBe('KRW');
          return { group, invoice };
        }
        const initial = await savedBill();
        await manager
          .getByRole('row')
          .filter({ hasText: initial.group.billedToName })
          .getByRole('button', { name: 'Open', exact: true })
          .click();
        const card = manager
          .getByRole('link', { name: requestId, exact: true })
          .locator('xpath=ancestor::div[.//button[normalize-space()="Issue invoice"]][1]');
        await expect(card.getByRole('textbox', { name: /^Invoice amount/ })).toHaveValue(
          '900000.00',
        );
        await card.getByRole('button', { name: 'Issue invoice', exact: true }).click();
        const issue = manager.getByRole('alertdialog', {
          name: 'Issue this invoice?',
          exact: true,
        });
        await issue.getByRole('checkbox').check();
        await issue.getByRole('button', { name: 'Issue invoice', exact: true }).click();
        await expect(issue).toBeHidden();
        const issued = await savedBill();
        expect(issued.invoice).toMatchObject({ invoiceStatus: 'INVOICED', amount: '900000.00' });

        const [agencyBilling] = await Promise.all([
          waitForGraphqlResponse(partnerPage, 'BillingSummary').then(async (r) => ({
            url: r.url(),
            query: r.request().postDataJSON(),
            headers: getAuthorizationHeaders(r),
          })),
          partnerPage.goto('/partner/billing'),
        ]);
        const response = await partnerPage.request.post(agencyBilling.url, {
          headers: agencyBilling.headers,
          data: { ...agencyBilling.query, variables: period },
        });
        const body = await response.json();
        expect(body.errors).toBeUndefined();
        expect(body.data.billingSummary.agencyGroups).toHaveLength(0);
        expect(body.data.billingSummary.directPartnerGroups).toHaveLength(1);
        expect(
          body.data.billingSummary.directPartnerGroups[0].requests.map((r: any) => r.requestNo),
        ).toEqual([requestId]);
        const group = body.data.billingSummary.directPartnerGroups.find((g: any) =>
          g.requests.some((r: any) => r.requestNo === requestId),
        );
        expect(group).toMatchObject({ billedToUserId: agencyUser.id, viaAgency: false });
        expect(group.requests.find((r: any) => r.requestNo === requestId)).toMatchObject({
          amount: '900000.00',
          currency: 'KRW',
        });
        await partnerPage
          .getByRole('combobox', { name: 'Year', exact: true })
          .selectOption(String(period.year));
        await partnerPage
          .getByRole('combobox', { name: 'Month', exact: true })
          .selectOption(String(period.month));
        await expect(partnerPage.getByRole('link', { name: requestId, exact: true })).toBeVisible();
        await expect(partnerPage.locator('main')).toContainText('KRW 900,000.00');
        const result = {
          requestId,
          requestStatus: 'COMPLETED',
          payerId: agencyUser.id,
          payer: issued.group.billedToName,
          directBilling: true,
          amount: '900000.00',
          currency: 'KRW',
        };
        await test.info().attach('agency-own-flow-bill-result', {
          body: JSON.stringify(result, null, 2),
          contentType: 'application/json',
        });
        await test.info().attach('agency-own-bill', {
          body: await partnerPage.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
        await verifyOwnRequestsOnly(partnerPage, [requestId]);
        await verifyNoConnections(manager, agencyUser.id, displayName);
        console.log(
          JSON.stringify({
            ...result,
            hospitalConnections: 0,
            onlyOwnRequestVisible: true,
            onlyOwnBillVisible: true,
          }),
        );
      });
      console.log(
        JSON.stringify({
          requestId,
          shipmentStatus: 'COMPLETED',
          requestStatus: 'COMPLETED',
          result: 'PASSED',
        }),
      );
    }
  } finally {
    await agencyContext.close();
    await managerContext.close();
  }
});
