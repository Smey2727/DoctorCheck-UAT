import { expect, Page, test } from '@playwright/test';
import { signIn, signOut } from '../../helpers/auth';

// Seeded Agency B is Agency 2. This synthetic Hospital B request was
// created by TC-HP-007 with Agency B selected; verify that linkage below.
const REQUEST_NO = 'REQ-2026-0673';
const REQUEST_PATH = `/partner/requests/${REQUEST_NO}`;

async function openRequest(page: Page) {
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().method() === 'POST'
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    page.goto(REQUEST_PATH),
  ]);
  expect(body.errors).toBeUndefined();
  await expect(page.getByRole('heading', { name: REQUEST_NO, exact: true })).toBeVisible();
  return body.data.request.details;
}

async function expectViewOnlyControls(page: Page) {
  const restricted = /^(?:edit|cancel|approve|resubmit|submit request|save changes|save request)\b/i;
  await expect(page.getByRole('button', { name: restricted })).toHaveCount(0);
  await expect(page.getByRole('link', { name: restricted })).toHaveCount(0);
}

test('TC-AG-003: Selected Agency 2 can view Hospital B request without edit, cancel or approve controls', async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  let selectedAgencyId: string;
  let patientCode: string;
  let requestStatus: string;

  await test.step('Verify Hospital B owns the request and has cancellation rights', async () => {
    await signIn(page, 'hospital.b@saerosoft.com');
    const details = await openRequest(page);
    expect(details).toMatchObject({ requestNo: REQUEST_NO, hospital: 'Hospital B Medical Center' });
    selectedAgencyId = details.financialAgencyUserId;
    patientCode = details.patientCode;
    requestStatus = details.status;
    expect(selectedAgencyId).toBeTruthy();
    expect(patientCode).toBeTruthy();
    const billing = page.getByRole('term').filter({ hasText: /^Billing account$/ }).locator('xpath=following-sibling::dd[1]');
    await expect(billing).toContainText('Agency B Distribution');
    await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeEnabled();
    await signOut(page);
  });

  const agencyContext = await browser.newContext({ baseURL });
  try {
    const agency = await agencyContext.newPage();
    agency.setDefaultTimeout(15_000);
    await test.step('Agency 2 is the selected agency and can load the request', async () => {
      const user = await signIn(agency, 'agency.b@saerosoft.com');
      expect(user.role).toBe('PARTNER');
      expect(user.id, 'Logged-in Agency 2 must match the request selected agency').toBe(selectedAgencyId);
      const details = await openRequest(agency);
      expect(details).toMatchObject({ requestNo: REQUEST_NO, hospital: 'Hospital B Medical Center',
        financialAgencyUserId: user.id, patientCode, status: requestStatus });
      await expect(agency.locator('main')).toContainText(patientCode);
      await expectViewOnlyControls(agency);
      await test.info().attach('agency-request-summary', { body: await agency.screenshot({ fullPage: true }), contentType: 'image/png' });
    });

    const checkedSections: string[] = [];
    for (const section of ['Files & 3D', 'Comments', 'History', 'Summary']) {
      await test.step(`${section}: no edit, cancel or approve controls`, async () => {
        const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const tab = agency.getByRole('button', { name: new RegExp(`^${escaped}(?:,|$)`) });
        await tab.click();
        await expect(tab).toHaveAttribute('aria-pressed', 'true');
        await expectViewOnlyControls(agency);
        checkedSections.push(section);
        await test.info().attach(`agency-${section.replace(/[^a-z0-9]/gi, '-')}`, { body: await agency.screenshot({ fullPage: true }), contentType: 'image/png' });
      });
    }

    await test.step('View access and missing mutation controls persist after reload', async () => {
      await agency.reload();
      await expect(agency.getByRole('heading', { name: REQUEST_NO, exact: true })).toBeVisible();
      await expect(agency.locator('main')).toContainText(patientCode);
      await expectViewOnlyControls(agency);
      const result = { requestId: REQUEST_NO, hospital: 'Hospital B Medical Center', agency: 'Agency B / Agency 2',
        selectedAgencyMatchesLogin: true, status: requestStatus, requestVisible: true,
        checkedSections, editCancelApproveControlsAbsent: true, ownerCancelControlEnabled: true };
      await test.info().attach('selected-agency-access-result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
      console.log(JSON.stringify(result));
    });
    await signOut(agency);
  } finally {
    await agencyContext.close();
  }
});
