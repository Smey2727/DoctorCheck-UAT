import { expect, Page, test } from '@playwright/test';
import { signIn } from '../../helpers/auth';

async function loadRequest(page: Page, requestNo: string, model = false) {
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    page.goto(model ? `/requests/${requestNo}/model` : `/partner/requests/${requestNo}`),
  ]);
  expect(body.errors).toBeUndefined();
  return body.data.request.details;
}

async function expectNoDecisionControls(page: Page) {
  // The Comments tab is a read-only navigation control and is allowed.
  const actions = /^(?:approve\b|request (?:a )?revision\b|(?:add|post|send|submit) comment\b|comment$|send$)/i;
  await expect.soft(page.getByRole('button', { name: actions })).toHaveCount(0);
  await expect.soft(page.getByRole('link', { name: actions })).toHaveCount(0);
  await expect.soft(page.getByRole('textbox', { name: /write a comment|revision memo|approval comment|add a comment/i })).toHaveCount(0);
  await expect.soft(page.getByRole('combobox', { name: /^Revision reason/ })).toHaveCount(0);
  await expect.soft(page.locator('textarea:not([readonly]):not([disabled])')).toHaveCount(0);
}

test('TC-AG-013: Selected Agency cannot comment, approve or request revision on a Hospital request at REVIEW_REQUESTED', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const hospitalUser = await signIn(page, 'hospital.b@saerosoft.com');
  await page.goto('/account');
  await page.goto('/partner/requests');
  await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Requests').then(r => r.json()),
    page.getByRole('button', { name: /^All(?:,|$)/ }).click(),
  ]);
  const queueResponse = () => page.waitForResponse(r => r.url().endsWith('/graphql')
    && r.request().postDataJSON()?.operationName === 'Requests'
    && JSON.stringify(r.request().postDataJSON()?.variables).includes('REVIEW_REQUESTED')).then(r => r.json());
  let [body] = await Promise.all([
    queueResponse(),
    page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('REVIEW_REQUESTED'),
  ]);
  expect(body.errors).toBeUndefined();
  const candidates: string[] = [];
  while (true) {
    expect(body.errors).toBeUndefined();
    for (const request of body.data.requests.items) {
      expect(request.status).toBe('REVIEW_REQUESTED');
      candidates.push(request.requestNo);
    }
    if (candidates.length >= body.data.requests.totalCount) break;
    expect(body.data.requests.items.length).toBeGreaterThan(0);
    [body] = await Promise.all([queueResponse(), page.getByRole('button', { name: 'Next', exact: true }).click()]);
  }
  if (!candidates.length) {
    const reason = 'TC-AG-013 BLOCKED: Hospital B has no request at REVIEW_REQUESTED. No design-decision privacy checks were executed.';
    test.info().annotations.push({ type: 'blocked', description: reason });
    await test.info().attach('no-review-request-fixture', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    console.log(reason);
    test.skip(true, reason);
    return;
  }

  const context = await browser.newContext({ baseURL });
  try {
    const agency = await context.newPage();
    agency.setDefaultTimeout(15_000);
    const agencyUser = await signIn(agency, 'agency.b@saerosoft.com');
    expect(agencyUser.id).not.toBe(hospitalUser.id);
    let target: any;
    for (const requestNo of candidates) {
      const details = await loadRequest(page, requestNo);
      expect(details.hospital).toBe('Hospital B Medical Center');
      if (details.financialAgencyUserId === agencyUser.id && details.status === 'REVIEW_REQUESTED') {
        target = details;
        break;
      }
    }
    if (!target) {
      const reason = 'TC-AG-013 BLOCKED: None of Hospital B\'s REVIEW_REQUESTED requests names Agency 2 as selected payer.';
      test.info().annotations.push({ type: 'blocked', description: reason });
      console.log(reason);
      test.skip(true, reason);
      return;
    }
    const requestNo = target.requestNo;
    test.info().annotations.push({ type: 'request', description: requestNo });
    await test.step('Hospital owner has comment and design-decision controls at this stage', async () => {
      const owner = await loadRequest(page, requestNo, true);
      expect(owner.status).toBe('REVIEW_REQUESTED');
      await expect(page.getByRole('textbox', { name: 'Write a comment...', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Approve v\d+/ }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Request revision', exact: true })).toBeVisible();
      await test.info().attach('hospital-owner-decision-controls', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    });

    await test.step('Selected Agency request details and Comments are view-only', async () => {
      const details = await loadRequest(agency, requestNo);
      expect(details).toMatchObject({ requestNo, status: 'REVIEW_REQUESTED', financialAgencyUserId: agencyUser.id });
      await expect(agency.getByRole('heading', { name: requestNo, exact: true })).toBeVisible();
      await expectNoDecisionControls(agency);
      for (const tabName of [/^Comments(?:,|$)/, /^Files & 3D(?:,|$)/]) {
        const tab = agency.getByRole('button', { name: tabName });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-pressed', 'true');
        await expectNoDecisionControls(agency);
      }
      await test.info().attach('agency-request-view-only', { body: await agency.screenshot({ fullPage: true }), contentType: 'image/png' });
    });
    await test.step('Agency model page and reload expose no comment, approval or revision controls', async () => {
      const details = await loadRequest(agency, requestNo, true);
      expect(details).toMatchObject({ requestNo, status: 'REVIEW_REQUESTED', financialAgencyUserId: agencyUser.id });
      await expectNoDecisionControls(agency);
      await agency.reload();
      await expect(agency.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      await expectNoDecisionControls(agency);
      await test.info().attach('agency-model-view-only', { body: await agency.screenshot({ fullPage: true }), contentType: 'image/png' });
    });
    expect((await loadRequest(page, requestNo)).status).toBe('REVIEW_REQUESTED');
    const result = { requestNo, hospital: 'Hospital B Medical Center', agency: 'Agency 2',
      status: 'REVIEW_REQUESTED', ownerControlsVisible: true, agencyDecisionControlsAbsent: test.info().errors.length === 0 };
    await test.info().attach('design-decision-access-result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify(result));
  } finally {
    await context.close();
  }
});
