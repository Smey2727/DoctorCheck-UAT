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
    .fill('TC-AG-011 Synthetic Hospital');
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

// Create an independent synthetic pending invoice each run. Payment is a UAT
// bookkeeping record; no real shipment or payment is made.
test('TC-AG-011: Agency Bills follows Manager PENDING to INVOICED to PAID without changing the amount', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(15_000);
  const agencyContext = await browser.newContext({ baseURL });
  agencyContext.setDefaultTimeout(15_000);
  const managerContext = await browser.newContext({ baseURL });
  const manager = await managerContext.newPage();
  manager.setDefaultTimeout(15_000);
  const addedRules: string[] = [];
  const rule = (size: string) =>
    manager
      .getByRole('row')
      .filter({ has: manager.getByRole('cell', { name: 'Cranial', exact: true }) })
      .filter({ has: manager.getByRole('cell', { name: 'PEEK', exact: true }) })
      .filter({ has: manager.getByRole('cell', { name: size, exact: true }) });
  async function openContract() {
    await manager.goto('/manager/pricing');
    await manager.getByRole('button', { name: 'Agency contract pricing', exact: true }).click();
    await Promise.all([
      waitForGraphqlResponse(manager, 'AgencyPricing'),
      manager.getByRole('button', { name: 'Agency A', exact: true }).click(),
    ]);
    await expect(manager.getByRole('heading', { name: 'Agency A', exact: true })).toBeVisible();
  }
  try {
    await signIn(manager, USERS.manager);
    await openContract();
    for (const size of ['Small', 'Medium', 'Large', 'Extra']) {
      if (await rule(size).count()) continue;
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
      addedRules.push(size);
      await manager.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(rule(size)).toBeVisible();
    }

    const agencyPage = await agencyContext.newPage();
    const caseCode = `TC-AG-011-${randomUUID().slice(0, 8)}`;
    const agencyUser = await signIn(agencyPage, USERS.agency);
    const requestId = await createAgencyOwnRequest(agencyPage, caseCode);
    test.info().annotations.push({ type: 'request', description: requestId });
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

      await test.step('Agency billing follows each manager invoice and payment update', async () => {
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
        expect(initial.invoice.invoiceStatus).toBe('PENDING');
        const history: object[] = [];
        async function refreshAgency(status: 'PENDING' | 'INVOICED' | 'PAID') {
          const [captured] = await Promise.all([
            waitForGraphqlResponse(partnerPage, 'BillingSummary').then(async (r) => ({
              url: r.url(),
              query: r.request().postDataJSON(),
              headers: getAuthorizationHeaders(r),
            })),
            partnerPage.goto('/partner/billing'),
          ]);
          const response = await partnerPage.request.post(captured.url, {
            headers: captured.headers,
            data: { ...captured.query, variables: period },
          });
          expect(response.ok()).toBe(true);
          const body = await response.json();
          expect(body.errors).toBeUndefined();
          const group = body.data.billingSummary.directPartnerGroups.find((g: any) =>
            g.requests.some((r: any) => r.requestNo === requestId),
          );
          expect(group).toMatchObject({ billedToUserId: agencyUser.id, viaAgency: false });
          const invoice = group.requests.find((r: any) => r.requestNo === requestId);
          expect(invoice).toMatchObject({
            invoiceStatus: status,
            currency: 'KRW',
            calculatedAmount: '900000.00',
            paidAmount: status === 'PAID' ? '900000.00' : '0.00',
          });
          expect(Number(invoice.amount ?? invoice.calculatedAmount)).toBe(900000);
          if (status !== 'PENDING') {
            expect(invoice.amount).toBe('900000.00');
            expect(invoice.outstanding).toBe(status === 'PAID' ? '0.00' : '900000.00');
            expect(invoice.invoicedAt).toBeTruthy();
          }
          if (status === 'PAID') expect(invoice.paidAt).toBeTruthy();
          await partnerPage
            .getByRole('combobox', { name: 'Year', exact: true })
            .selectOption(String(period.year));
          await partnerPage
            .getByRole('combobox', { name: 'Month', exact: true })
            .selectOption(String(period.month));
          await expect(
            partnerPage.getByRole('link', { name: requestId, exact: true }),
          ).toBeVisible();
          await expect(partnerPage.locator('main')).toContainText('KRW 900,000.00');
          history.push({
            status,
            amount: invoice.amount ?? invoice.calculatedAmount,
            paidAmount: invoice.paidAmount,
            outstanding: invoice.outstanding,
          });
          await test.info().attach(`agency-${status.toLowerCase()}`, {
            body: JSON.stringify({ requestId, payerId: group.billedToUserId, invoice }, null, 2),
            contentType: 'application/json',
          });
        }
        await refreshAgency('PENDING');
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
        await refreshAgency('INVOICED');

        const paymentCard = manager
          .getByRole('link', { name: requestId, exact: true })
          .locator('xpath=ancestor::div[.//button[normalize-space()="Record payment"]][1]');
        await paymentCard.getByRole('textbox', { name: /^Payment amount/ }).fill('900000.00');
        await paymentCard.getByRole('button', { name: 'Record payment', exact: true }).click();
        const payment = manager.getByRole('alertdialog', {
          name: 'Record this payment?',
          exact: true,
        });
        await payment.getByRole('checkbox').check();
        await payment.getByRole('button', { name: 'Record payment', exact: true }).click();
        await expect(payment).toBeHidden();
        expect((await savedBill()).invoice).toMatchObject({
          invoiceStatus: 'PAID',
          amount: '900000.00',
          paidAmount: '900000.00',
          outstanding: '0.00',
        });
        await refreshAgency('PAID');

        const result = {
          requestId,
          requestStatus: 'COMPLETED',
          payerId: agencyUser.id,
          payer: issued.group.billedToName,
          directBilling: true,
          amount: '900000.00',
          currency: 'KRW',
          history,
        };
        await test.info().attach('agency-own-flow-bill-result', {
          body: JSON.stringify(result, null, 2),
          contentType: 'application/json',
        });
        await test.info().attach('agency-own-bill', {
          body: await partnerPage.screenshot({ fullPage: true }),
          contentType: 'image/png',
        });
        console.log(JSON.stringify(result));
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
    test.setTimeout(test.info().timeout + 30_000);
    try {
      for (const size of addedRules) {
        await openContract();
        await rule(size).getByRole('button', { name: 'Remove rule', exact: true }).click();
        const confirmation = manager.getByRole('alertdialog');
        await confirmation.getByRole('button', { name: 'Remove rule', exact: true }).click();
        await expect(confirmation).toBeHidden();
        await expect(rule(size)).toHaveCount(0);
      }
    } finally {
      await managerContext.close();
      await agencyContext.close();
    }
  }
});
