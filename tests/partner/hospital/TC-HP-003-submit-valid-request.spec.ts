import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';
import { createHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

test('TC-HP-003: Valid submission creates an Info Sheet, notifies both roles and enters the Counselor queue', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const counselorContext = await browser.newContext({ baseURL });
  counselorContext.setDefaultTimeout(15_000);
  const evidence: Record<string, unknown> = {};
  try {
    const code = `TC-HP-003-${randomUUID().slice(0, 8)}`;
    await signIn(page, USERS.hospital);
    const ct = { ...syntheticCtRoundTwo, name: `${code}-synthetic-ct.zip` };
    const requestId = await createHospitalReworkRequest(page, code, ct);
    evidence.requestId = requestId;
    test.info().annotations.push({ type: 'request', description: requestId });
    const status = page.getByRole('heading', { name: requestId, exact: true }).locator('..')
      .getByRole('button', { name: 'Submitted', exact: true });
    await test.step('Request persists as SUBMITTED with its CT attached', async () => {
      await expect(status).toBeVisible();
      await page.reload();
      await expect(status).toBeVisible();
      await expect(page.getByRole('button', { name: 'Print info sheet', exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^Files & 3D(?:,|$)/ }).click();
      await expect(page.getByText(ct.name, { exact: true }).first()).toBeVisible();
      evidence.persistedStatus = 'SUBMITTED';
      evidence.persistedCtFile = ct.name;
      await test.info().attach('submitted-request', { body: await page.screenshot(), contentType: 'image/png' });
    });
    const counselor = await counselorContext.newPage();
    await signIn(counselor, USERS.counselor);
    await test.step('Unassigned request is visible in the Counselor Submitted queue', async () => {
      await counselor.goto('/counselor/requests');
      await counselor.getByRole('searchbox', { name: /^Search request no\./ }).fill(requestId);
      await counselor.getByRole('combobox', { name: 'Status', exact: true }).selectOption('SUBMITTED');
      const row = counselor.getByRole('row').filter({ has: counselor.getByRole('cell', { name: requestId, exact: true }) });
      await expect(row).toHaveCount(1);
      await expect(row.getByRole('cell', { name: 'Submitted', exact: true })).toBeVisible();
      await expect(row.getByRole('cell', { name: 'Unassigned', exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Claim', exact: true })).toBeEnabled();
      evidence.counselorQueue = 'SUBMITTED / Unassigned';
      await test.info().attach('counselor-queue', { body: await counselor.screenshot(), contentType: 'image/png' });
    });
    await test.step('A generated Request Info Sheet is available for the submitted request', async () => {
      await expect(async () => {
        const [body] = await Promise.all([
          counselor.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'Documents').then(r => r.json()),
          counselor.goto(`/counselor/requests/${requestId}`),
        ]);
        expect(body.errors).toBeUndefined();
        const infoSheets = body.data.documents.filter((d: any) => /^REQ-INFO-/.test(d.documentNo));
        expect(infoSheets).toHaveLength(1);
        expect(infoSheets[0]).toMatchObject({ requestNo: requestId, generatedFile: { contentType: 'application/pdf', status: 'AVAILABLE' } });
        evidence.infoSheet = infoSheets[0];
      }).toPass({ timeout: 30_000, intervals: [1000, 2000, 5000] });
      await counselor.getByRole('button', { name: /^Docs(?:,|$)/ }).click();
      const document = counselor.getByRole('listitem').filter({ hasText: 'Request Info Sheet' });
      await expect(document).toHaveCount(1);
      await expect(document.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
    });
    await test.step('Hospital receives submission confirmation for this request', async () => {
      await page.goto('/notifications');
      const notification = page.getByRole('article').filter({ hasText: requestId }).filter({ hasText: /submitted|submission/i });
      await expect(notification).toHaveCount(1);
      evidence.hospitalNotification = await notification.innerText();
      await test.info().attach('hospital-confirmation', { body: await page.screenshot(), contentType: 'image/png' });
    });
    await test.step('Counselor receives a new-request notification', async () => {
      await counselor.goto('/notifications');
      const notification = counselor.getByRole('article').filter({ hasText: requestId }).filter({ hasText: /submitted|submission|new request/i });
      await expect(notification).toHaveCount(1);
      evidence.counselorNotification = await notification.innerText();
      await test.info().attach('counselor-notified', { body: await counselor.screenshot(), contentType: 'image/png' });
    });
    await test.info().attach('valid-submission-results', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify({ requestId, status: 'SUBMITTED', infoSheetCreated: true, hospitalNotified: true, counselorNotified: true, inCounselorQueue: true, result: 'PASSED' }));
  } finally { await counselorContext.close(); }
});
