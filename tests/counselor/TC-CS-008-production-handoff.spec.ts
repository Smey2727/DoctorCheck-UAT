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

// TC-CS-008: Production requires an approved design and creates a work order and pending operations.
test('TC-CS-008: Production handoff is blocked until design approval and creates pending operations', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-CS-008-${randomUUID().slice(0, 8)}`;
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
    // Handoff refetches documents on this page. A fresh page prevents those
    // in-flight responses from matching our persisted-state verification.
    const verificationPage = await page.context().newPage();
    const [operations, documents, request] = await Promise.all([
      waitForGraphqlResponse(verificationPage, 'RequestOperations').then((response) =>
        response.json(),
      ),
      waitForGraphqlResponse(verificationPage, 'Documents').then((response) => response.json()),
      openCounselorRequest(verificationPage, requestId),
    ]);
    expect(request.details.status).toBe('PRODUCTION_HANDOFF');
    expect(operations.errors).toBeUndefined();
    expect(operations.data.requestOperations).toMatchObject({
      requestNo: requestId,
      productionStatus: 'PENDING',
      shipmentStatus: 'PENDING',
    });
    expect(documents.errors).toBeUndefined();
    const workOrders = documents.data.documents.filter(
      (document: { documentType: string }) => document.documentType === 'WORK_ORDER',
    );
    expect(workOrders).toHaveLength(1);
    expect(workOrders[0]).toMatchObject({
      requestNo: requestId,
      generatedFile: { contentType: 'application/pdf', status: 'AVAILABLE' },
    });
    expect(workOrders[0].documentNo).toMatch(/^WO-/);
    const drawing = documents.data.documents.find(
      (document: { documentType: string }) => document.documentType === 'APPROVED_DRAWING',
    );
    expect(drawing).toBeDefined();
    const approvedDesign = request.details.attachments.find(
      (attachment: { category: string; version: number }) =>
        attachment.category === 'DESIGN_RESULT' && attachment.version === 1,
    );
    expect(approvedDesign).toBeDefined();
    expect(workOrders[0].sourceAttachmentId).toBe(approvedDesign.id);
    // Approved drawings now collect design sources per request line.
    expect(drawing.designSources).toHaveLength(1);
    expect(drawing.designSources[0]).toMatchObject({
      requestLineId: workOrders[0].requestLineId,
      sourceAttachmentId: approvedDesign.id,
      file: { id: approvedDesign.file.id, originalName: `${caseCode}-design-v1.stl` },
    });
    await expect(requestStatus(verificationPage, requestId, 'Production handoff')).toBeVisible();
    await verificationPage.getByRole('button', { name: /^Docs,/ }).click();
    const workOrder = verificationPage.getByRole('listitem').filter({ hasText: 'Work Order' });
    await expect(workOrder).toHaveCount(1);
    await expect(workOrder.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
    await verificationPage.close();
  } finally {
    await hospitalContext.close();
  }
});
