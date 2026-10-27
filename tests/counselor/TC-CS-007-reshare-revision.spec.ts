import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { waitForGraphqlResponse } from '../helpers/graphql';
import {
  requestStatus,
  openCounselorRequest,
  uploadDesign,
  shareDesign,
  getDesignVersions,
  getRevisionSnapshot,
} from '../helpers/design-workflow';
import { signIn, USERS } from '../helpers/auth';
import { createHospitalReworkRequest } from '../helpers/requests';
import { syntheticCtRoundTwo } from '../helpers/synthetic-ct';
import { syntheticModel } from '../helpers/synthetic-model';

// TC-CS-007: Resharing creates a new version and preserves the original design.
test('TC-CS-007: Counselor can reshare Revision 2 while preserving Revision 1', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const hospitalPage = await hospitalContext.newPage();
    const caseCode = `TC-CS-007-${randomUUID().slice(0, 8)}`;
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
    const originalVersions = await getDesignVersions(page, requestId);
    expect(originalVersions).toHaveLength(1);
    const revisionOne = getRevisionSnapshot(originalVersions[0]);
    const partnerPage = await hospitalContext.newPage();
    const firstSharedCard = partnerPage.getByRole('article').filter({
      has: partnerPage.getByRole('button', { name: /^v1 .*Design result Shared/ }),
    });
    let originalSharedRecord: { notes: string[]; document: string | null };
    await test.step('Hospital requests a revision to Revision 1', async () => {
      await partnerPage.goto(`/requests/${requestId}/model`);
      await expect(firstSharedCard).toBeVisible();
      originalSharedRecord = {
        notes: await firstSharedCard.getByRole('paragraph').allTextContents(),
        document: await firstSharedCard.getByRole('button', { name: /^DSN-/ }).textContent(),
      };
      const decision = partnerPage.getByRole('region', {
        name: 'Final case decision',
        exact: true,
      });
      await decision
        .getByRole('combobox', { name: /^Revision reason/ })
        .selectOption({ label: 'Dimensions or thickness' });
      await decision
        .getByRole('textbox', { name: 'Revision memo or optional approval comment', exact: true })
        .fill(`${caseCode}: Please increase dimensions to 12 mm.`);
      await decision.getByRole('button', { name: 'Request revision', exact: true }).click();
      const confirmation = partnerPage.getByRole('alertdialog', {
        name: 'Request a design revision?',
        exact: true,
      });
      await confirmation.getByRole('button', { name: 'Request revision', exact: true }).click();
      await expect(confirmation).toBeHidden();
      await expect(async () => {
        const request = await openCounselorRequest(page, requestId);
        expect(request.details.status).toBe('REVISION_REQUESTED');
      }).toPass({ timeout: 15000 });
    });
    await test.step('Counselor registers and reshares Revision 2', async () => {
      await openCounselorRequest(page, requestId, true);
      await uploadDesign(page, requestId, caseCode, 2, 12);
      await shareDesign(page, requestId, caseCode, 2);
    });
    await test.step('Revision 1 is preserved and Revision 2 is shared', async () => {
      const versions = await getDesignVersions(page, requestId);
      expect(versions).toHaveLength(2);
      const old = versions.find((file: any) => file.version === 1);
      const latest = versions.find((file: any) => file.version === 2);
      expect(old).toBeDefined();
      expect(getRevisionSnapshot(old)).toEqual(revisionOne);
      expect(old.latest).toBe(false);
      expect(latest).toMatchObject({
        latest: true,
        file: { originalName: `${caseCode}-design-v2.stl` },
        specification: {
          dimensions: { widthMm: '12.000', heightMm: '12.000', thicknessMm: '12.000' },
        },
      });
      expect(latest.id).not.toBe(old.id);
      expect(latest.file.id).not.toBe(old.file.id);
      await partnerPage.goto(`/requests/${requestId}/model`);
      const finalDecision = partnerPage.getByRole('region', {
        name: 'Final case decision',
        exact: true,
      });
      await expect(finalDecision).toContainText('This decision applies to v2.');
      await expect(
        finalDecision.getByRole('button', { name: 'Approve design and price', exact: true }),
      ).toBeVisible();
      await expect(firstSharedCard).toBeVisible();
      // The decision badge changes to Revision requested; the shared content must not.
      expect({
        notes: await firstSharedCard.getByRole('paragraph').allTextContents(),
        document: await firstSharedCard.getByRole('button', { name: /^DSN-/ }).textContent(),
      }).toEqual(originalSharedRecord);
      await expect(firstSharedCard.getByText('Revision requested', { exact: true })).toBeVisible();
      const secondSharedCard = partnerPage.getByRole('article').filter({
        has: partnerPage.getByRole('button', { name: /^v2 .*Design result Shared/ }),
      });
      await expect(secondSharedCard).toContainText(`${caseCode}-design-v2.stl`);
      await expect(secondSharedCard).toContainText(
        `${caseCode}: Please review synthetic design revision 2.`,
      );
    });
  } finally {
    await hospitalContext.close();
  }
});
