import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, Page, test as base } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';

// Browser projects run in separate worker processes, so describe.serial does
// not protect this shared UAT membership. Hold a localhost port for the whole
// test, including restoration. The OS releases it if a worker exits.
// This coordinates runs on this machine; separate CI machines need isolation.
const test = base.extend<{ membershipLock: void }>({
  membershipLock: [async ({}, use, testInfo) => {
    const deadline = Date.now() + 300_000;
    while (true) {
      const server = createServer(socket => socket.destroy());
      const acquired = await new Promise<boolean>((resolve, reject) => {
        server.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') resolve(false);
          else reject(error);
        });
        server.listen({ host: '127.0.0.1', port: 47606, exclusive: true }, () => resolve(true));
      });
      if (acquired) {
        console.log(`${testInfo.project.name}: acquired TC-AG-006 membership lock`);
        try {
          await use();
        } finally {
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          console.log(`${testInfo.project.name}: released TC-AG-006 membership lock`);
        }
        return;
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for another TC-AG-006 browser run to restore the shared membership.');
      await delay(250);
    }
  }, { auto: true, timeout: 310_000 }],
});

const REQUEST_NO = 'REQ-2026-0673';
const HOSPITAL_LOGIN = 'hospital.b@saerosoft.com';

async function openAgency(page: Page) {
  await page.goto('/manager/agencies');
  const [captured] = await Promise.all([
    page.waitForResponse(async r => {
      if (!r.url().endsWith('/graphql') || r.request().postDataJSON()?.operationName !== 'Agency') return false;
      return (await r.json().catch(() => null))?.data?.agency?.displayName === 'Agency B';
    }).then(async r => ({ body: await r.json(), endpoint: r.url(), authorization: r.request().headers().authorization })),
    page.getByRole('button', { name: /^Agency B Agency B Distribution / }).click(),
  ]);
  expect(captured.body.errors).toBeUndefined();
  return { ...captured, agency: captured.body.data.agency };
}

async function openRequest(page: Page, role: 'manager' | 'partner') {
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    page.goto(`/${role}/requests/${REQUEST_NO}`),
  ]);
  expect(body.errors).toBeUndefined();
  return body.data.request.details;
}

function savedFields(details: any) {
  return Object.fromEntries(['requestNo', 'hospital', 'patientCode', 'status', 'financialAgencyUserId',
    'quotedPrice', 'priceBaseAmount', 'priceCurrency', 'priceCalculatedAt'].map(key => [key, details[key]]));
}

// This test temporarily changes the shared Hospital B / Agency B connection.
// The automatic fixture serializes browser projects before the initial read.
test('TC-AG-006: Agency 2 retains historical request access after its Hospital B connection is deactivated', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, USERS.manager);
  const original = await openAgency(page);
  const members = original.agency.members.filter((member: any) => member.memberEmail === HOSPITAL_LOGIN && member.active);
  expect(members, 'Hospital B must have an active Agency 2 connection before testing deactivation').toHaveLength(1);
  const member = members[0];
  const before = await openRequest(page, 'manager');
  expect(before).toMatchObject({ requestNo: REQUEST_NO, hospital: 'Hospital B Medical Center', financialAgencyUserId: original.agency.id });
  const saved = savedFields(before);
  let restore = false;
  const evidence: Record<string, unknown> = { requestNo: REQUEST_NO, agency: 'Agency B / Agency 2', connectionInitiallyActive: true };
  const context = await browser.newContext({ baseURL });
  let agencySaved: Record<string, unknown>;
  try {
    const agency = await context.newPage();
    agency.setDefaultTimeout(15_000);
    await test.step('Record the Agency-visible request before deactivation', async () => {
      const user = await signIn(agency, 'agency.b@saerosoft.com');
      expect(user.id).toBe(original.agency.id);
      const details = await openRequest(agency, 'partner');
      expect(details.financialAgencyUserId).toBe(original.agency.id);
      agencySaved = savedFields(details);
      await expect(agency.getByRole('heading', { name: REQUEST_NO, exact: true })).toBeVisible();
    });
    await test.step('Manager deactivates Hospital B membership in Agency 2', async () => {
      await openAgency(page);
      const row = page.getByRole('row').filter({ hasText: HOSPITAL_LOGIN });
      await row.getByRole('button', { name: 'Deactivate', exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: 'Deactivate this agency membership?', exact: true });
      restore = true;
      await confirmation.getByRole('button', { name: 'Deactivate membership', exact: true }).click();
      await expect(confirmation).toBeHidden();
      const current = (await openAgency(page)).agency;
      expect(current.members.find((m: any) => m.membershipId === member.membershipId)).toMatchObject({ active: false });
      expect(current.members.filter((m: any) => m.memberUserId === member.memberUserId && m.active)).toHaveLength(0);
      evidence.connectionDeactivated = true;
      await test.info().attach('connection-deactivated', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    });

    await test.step('Agency 2 keeps its session and reopens the old request with its saved agency unchanged', async () => {
      // Keep the Agency session, but fetch the request again from the server.
      await agency.goto('/account');
      const after = await openRequest(agency, 'partner');
      expect(savedFields(after)).toEqual(agencySaved);
      await expect(agency.getByRole('heading', { name: REQUEST_NO, exact: true })).toBeVisible();
      await expect(agency.locator('main')).toContainText(before.patientCode);
      const billing = agency.getByRole('term').filter({ hasText: /^Billing account$/ }).locator('xpath=following-sibling::dd[1]');
      await expect(billing).toContainText('Agency B Distribution');
      await expect(agency.getByRole('alert')).toHaveCount(0);
      await test.info().attach('historical-request-visible-after-deactivation', { body: await agency.screenshot({ fullPage: true }), contentType: 'image/png' });
      await agency.goto('/account');
      expect(savedFields(await openRequest(agency, 'partner'))).toEqual(agencySaved);
      await expect(billing).toContainText('Agency B Distribution');
      // Compare each role with its own baseline because Manager-only prices
      // are masked in the Agency response.
      expect(savedFields(await openRequest(page, 'manager'))).toEqual(saved);
      // Recheck the connection while Agency 2 is still viewing the request.
      const current = (await openAgency(page)).agency;
      expect(current.members.filter((m: any) => m.memberUserId === member.memberUserId && m.active)).toHaveLength(0);
      evidence.historicalRequestVisible = true;
      evidence.savedAgencyUnchanged = true;
      evidence.savedRequestFieldsUnchanged = true;
      evidence.agencySessionReused = true;
    });
  } finally {
    try {
      if (restore) {
        test.setTimeout(test.info().timeout + 30_000);
        await test.step('Restore the original connection and pricing policy', async () => {
          const current = (await openAgency(page)).agency;
          if (!current.members.some((m: any) => m.memberUserId === member.memberUserId && m.active)) {
            const response = await page.request.post(original.endpoint, {
              headers: original.authorization ? { authorization: original.authorization } : {},
              data: { operationName: 'AddAgencyMember',
                query: 'mutation AddAgencyMember($input: AddAgencyMemberInput!) { addAgencyMember(input: $input) { id } }',
                variables: { input: { agencyUserId: original.agency.id, memberUserId: member.memberUserId,
                  pricePolicy: member.pricePolicy, customAdjustmentPercent: member.customAdjustmentPercent } } },
            });
            expect(response.ok()).toBe(true);
            expect((await response.json()).errors).toBeUndefined();
          }
          const restored = (await openAgency(page)).agency.members.filter((m: any) => m.memberUserId === member.memberUserId && m.active);
          expect(restored).toHaveLength(1);
          expect(restored[0]).toMatchObject({ pricePolicy: member.pricePolicy, customAdjustmentPercent: member.customAdjustmentPercent });
          evidence.connectionRestored = true;
        });
      }
    } finally {
      await test.info().attach('deactivation-history-result', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      console.log(JSON.stringify(evidence));
      await context.close();
    }
  }
});
