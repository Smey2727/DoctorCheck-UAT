import { randomUUID } from 'node:crypto';
import { expect, Page, Browser, test } from '@playwright/test';
import { waitForGraphqlResponse } from '../../helpers/graphql';
import { signIn, USERS } from '../../helpers/auth';
import { createHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';
import { syntheticModel } from '../../helpers/synthetic-model';
import {
  requestStatus,
  openCounselorRequest,
  uploadDesign,
  shareDesign,
} from '../../helpers/design-workflow';

async function loadRequest(page: Page, requestNo: string, model = false) {
  const [body] = await Promise.all([
    page
      .waitForResponse(async (response) => {
        if (!response.url().endsWith('/graphql')) return false;
        const body = await response.json().catch(() => null);
        return body?.data?.request?.details?.requestNo === requestNo;
      })
      .then((response) => response.json()),
    page.goto(model ? `/requests/${requestNo}/model` : `/partner/requests/${requestNo}`),
  ]);
  expect(body.errors).toBeUndefined();
  return body.data.request.details;
}

async function expectNoDecisionControls(page: Page) {
  // The Comments tab is a read-only navigation control and is allowed.
  const actions =
    /^(?:approve\b|request (?:a )?revision\b|(?:add|post|send|submit) comment\b|comment$|send$)/i;
  await expect.soft(page.getByRole('button', { name: actions })).toHaveCount(0);
  await expect.soft(page.getByRole('link', { name: actions })).toHaveCount(0);
  await expect
    .soft(
      page.getByRole('textbox', {
        name: /write a comment|revision memo|approval comment|add a comment/i,
      }),
    )
    .toHaveCount(0);
  await expect.soft(page.getByRole('combobox', { name: /^Revision reason/ })).toHaveCount(0);
  await expect.soft(page.locator('textarea:not([readonly]):not([disabled])')).toHaveCount(0);
}

async function createReviewFixture(hospital: Page, browser: Browser, baseURL: string | undefined) {
  const counselorContext = await browser.newContext({ baseURL });
  counselorContext.setDefaultTimeout(15_000);
  const counselor = await counselorContext.newPage();
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
      manager.getByRole('button', { name: 'Agency B', exact: true }).click(),
    ]);
    await expect(manager.getByRole('heading', { name: 'Agency B', exact: true })).toBeVisible();
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

    const caseCode = 'TC-AG-013-' + randomUUID().slice(0, 8);
    const requestId = await createHospitalReworkRequest(
      hospital,
      caseCode,
      syntheticCtRoundTwo,
      undefined,
      'PEEK',
    );
    await signIn(counselor, USERS.counselor);
    await test.step('Prepare a fresh request and accept its sources', async () => {
      await counselor.goto('/counselor/requests');
      await counselor.getByRole('searchbox', { name: /^Search request no\./ }).fill(requestId);
      const row = counselor
        .getByRole('row')
        .filter({ has: counselor.getByRole('cell', { name: requestId, exact: true }) });
      const claim = row.getByRole('button', { name: 'Claim', exact: true });
      await claim.click();
      await expect(claim).toBeHidden();
      await counselor.goto(`/counselor/requests/${requestId}`);
      await counselor.getByRole('button', { name: 'Start review', exact: true }).click();
      const note = counselor.getByRole('textbox', {
        name: 'Optional note for the status history',
        exact: true,
      });
      await note.fill(`${caseCode}: source review`);
      await note.locator('..').getByRole('button', { name: 'Start review', exact: true }).click();
      await expect(requestStatus(counselor, requestId, 'In review')).toBeVisible();
      await expect(async () => {
        await counselor.reload();
        await counselor.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
        await expect(
          counselor.getByRole('button', { name: 'Accept latest round', exact: true }),
        ).toBeEnabled({ timeout: 1_000 });
      }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
      await counselor.getByRole('button', { name: 'Accept latest round', exact: true }).click();
      await counselor.getByRole('button', { name: /^Enter design stage$/i }).click();
      await expect(requestStatus(counselor, requestId, 'Converting 3D')).toBeVisible();
    });
    await test.step('Register converted model', async () => {
      await openCounselorRequest(counselor, requestId, true);
      const upload = counselor.getByRole('button', { name: 'Upload converted 3D', exact: true });
      await expect(upload).toBeVisible();
      const fileChooser = counselor.waitForEvent('filechooser');
      await upload.click();
      const [response] = await Promise.all([
        waitForGraphqlResponse(counselor, 'RegisterDesignFile'),
        (await fileChooser).setFiles(syntheticModel(`${caseCode}-converted.stl`)),
      ]);
      const body = await response.json();
      expect(body.errors).toBeUndefined();
      await expect(async () => {
        const request = await openCounselorRequest(counselor, requestId, true);
        expect(request.details.allowedActions).toContain('REGISTER_DESIGN_FILE');
        await expect(
          counselor.getByRole('button', { name: 'Upload design result', exact: true }),
        ).toBeVisible();
      }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 5_000] });
    });
    await test.step('Register and share Revision 1', async () => {
      await uploadDesign(counselor, requestId, caseCode, 1, 10);
      await shareDesign(counselor, requestId, caseCode, 1);
    });
    expect((await openCounselorRequest(counselor, requestId)).details.status).toBe(
      'REVIEW_REQUESTED',
    );
    return requestId;
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
      await counselorContext.close();
      await managerContext.close();
    }
  }
}
test('TC-AG-013: Selected Agency cannot comment, approve or request revision on a Hospital request at REVIEW_REQUESTED', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(15_000);
  const hospitalUser = await signIn(page, 'hospital.b@saerosoft.com');
  const candidates = [await createReviewFixture(page, browser, baseURL)];

  const context = await browser.newContext({ baseURL });
  try {
    const agency = await context.newPage();
    agency.setDefaultTimeout(15_000);
    const agencyUser = await signIn(agency, 'agency.b@saerosoft.com');
    expect(agencyUser.id).not.toBe(hospitalUser.id);
    const requestNo = candidates[0];
    const target = await loadRequest(page, requestNo);
    expect(target).toMatchObject({
      hospital: 'Hospital B Medical Center',
      financialAgencyUserId: agencyUser.id,
      status: 'REVIEW_REQUESTED',
    });
    test.info().annotations.push({ type: 'request', description: requestNo });
    await test.step('Hospital owner has comment and design-decision controls at this stage', async () => {
      const owner = await loadRequest(page, requestNo, true);
      expect(owner.status).toBe('REVIEW_REQUESTED');
      await expect(
        page.getByRole('textbox', { name: 'Write a comment...', exact: true }),
      ).toBeVisible();
      await expect(
        page
          .getByRole('region', { name: 'Final case decision', exact: true })
          .getByRole('button', { name: 'Approve v1', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Request revision', exact: true }),
      ).toBeVisible();
      await test.info().attach('hospital-owner-decision-controls', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    });

    await test.step('Selected Agency request details and Comments are view-only', async () => {
      const details = await loadRequest(agency, requestNo);
      expect(details).toMatchObject({
        requestNo,
        status: 'REVIEW_REQUESTED',
        financialAgencyUserId: agencyUser.id,
      });
      await expect(agency.getByRole('heading', { name: requestNo, exact: true })).toBeVisible();
      await expectNoDecisionControls(agency);
      for (const tabName of [/^Comments(?:,|$)/, /^Files & 3D(?:,|$)/]) {
        const tab = agency.getByRole('button', { name: tabName });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-pressed', 'true');
        await expectNoDecisionControls(agency);
      }
      await test.info().attach('agency-request-view-only', {
        body: await agency.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    });
    await test.step('Agency model page and reload expose no comment, approval or revision controls', async () => {
      const details = await loadRequest(agency, requestNo, true);
      expect(details).toMatchObject({
        requestNo,
        status: 'REVIEW_REQUESTED',
        financialAgencyUserId: agencyUser.id,
      });
      await expectNoDecisionControls(agency);
      await agency.reload();
      await expect(agency.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      await expectNoDecisionControls(agency);
      await test.info().attach('agency-model-view-only', {
        body: await agency.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    });
    expect((await loadRequest(page, requestNo)).status).toBe('REVIEW_REQUESTED');
    const result = {
      requestNo,
      hospital: 'Hospital B Medical Center',
      agency: 'Agency 2',
      status: 'REVIEW_REQUESTED',
      ownerControlsVisible: true,
      agencyDecisionControlsAbsent: test.info().errors.length === 0,
    };
    await test.info().attach('design-decision-access-result', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    console.log(JSON.stringify(result));
  } finally {
    await context.close();
  }
});
