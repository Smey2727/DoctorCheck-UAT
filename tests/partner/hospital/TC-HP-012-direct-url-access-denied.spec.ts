import { expect, test } from '@playwright/test';
import { signIn } from '../../helpers/auth';

// A synthetic Hospital B request created by TC-HP-007. Verify ownership first.
const HOSPITAL_B_REQUEST = 'REQ-2026-0673';

test('TC-HP-012: Hospital A cannot open Hospital B requests or Manager screens by URL', async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  const hospitalBContext = await browser.newContext({ baseURL });
  hospitalBContext.setDefaultTimeout(15_000);
  try {
    const hospitalB = await hospitalBContext.newPage();
    await signIn(hospitalB, 'hospital.b@saerosoft.com');
    const [owned] = await Promise.all([
      hospitalB.waitForResponse(r => r.url().endsWith('/graphql')
        && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
      hospitalB.goto(`/partner/requests/${HOSPITAL_B_REQUEST}`),
    ]);
    expect(owned.errors).toBeUndefined();
    expect(owned.data.request.details).toMatchObject({ requestNo: HOSPITAL_B_REQUEST, hospital: 'Hospital B Medical Center' });
    await expect(hospitalB.getByRole('heading', { name: HOSPITAL_B_REQUEST, exact: true })).toBeVisible();
    await test.info().attach('owner-can-access-hospital-b-request', { body: await hospitalB.screenshot(), contentType: 'image/png' });

    await signIn(page, 'hospital.a@saerosoft.com');
    await test.step('Direct URL to Hospital B request denies Hospital A and returns no request data', async () => {
      const [denied] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql')
          && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
        page.goto(`/partner/requests/${HOSPITAL_B_REQUEST}`),
      ]);
      expect(denied.errors?.length).toBeGreaterThan(0);
      expect(denied.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ extensions: expect.objectContaining({ classification: 'FORBIDDEN' }) }),
      ]));
      expect(denied.data?.request).toBeFalsy();
      await expect(page.getByRole('alert')).toHaveText('You do not have permission to perform this action.');
      await expect(page.getByRole('heading', { name: HOSPITAL_B_REQUEST, exact: true })).toHaveCount(0);
      await expect(page.getByText(owned.data.request.details.patientCode, { exact: true })).toHaveCount(0);
      await test.info().attach('other-hospital-request-denied', { body: await page.screenshot(), contentType: 'image/png' });
      await test.info().attach('request-denial-response', { body: JSON.stringify(denied, null, 2), contentType: 'application/json' });
    });
    await test.step('Direct URL to Manager pricing cannot render Manager controls', async () => {
      await page.goto('/manager/pricing');
      await expect(page).toHaveURL(/\/partner\/requests$/);
      await expect(page.getByRole('heading', { name: 'My Requests', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'New price', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Save all', exact: true })).toHaveCount(0);
      console.log(JSON.stringify({ account: 'Hospital A', otherHospitalRequest: HOSPITAL_B_REQUEST,
        requestAccess: 'FORBIDDEN', managerScreen: '/manager/pricing', redirectedTo: page.url() }));
      await test.info().attach('manager-screen-denied', { body: await page.screenshot(), contentType: 'image/png' });
    });
    test.info().annotations.push({ type: 'request', description: HOSPITAL_B_REQUEST });
  } finally {
    await hospitalBContext.close();
  }
});
