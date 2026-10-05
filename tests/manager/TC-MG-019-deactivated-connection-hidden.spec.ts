import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';
import { createHospitalReworkRequest } from '../helpers/requests';

// The seeded Hospital B uses Agency A / Agency B for the case's Agency 1 / Agency 2.
test('TC-MG-019: Deactivated agency is hidden and the remaining connection is selected automatically', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, USERS.manager);
  async function agencyB() {
    await page.goto('/manager/agencies');
    const [response] = await Promise.all([
      page.waitForResponse(async r => {
        if (!r.url().endsWith('/graphql') || r.request().postDataJSON()?.operationName !== 'Agency') return false;
        return (await r.json().catch(() => null))?.data?.agency?.displayName === 'Agency B';
      }),
      page.getByRole('button', { name: /^Agency B Agency B Distribution / }).click(),
    ]);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    return { agency: body.data.agency, endpoint: response.url(), authorization: (await response.request().allHeaders()).authorization };
  }
  const original = await agencyB();
  const members = original.agency.members.filter((m: any) => m.memberEmail === 'hospital.b@saerosoft.com' && m.active);
  expect(members).toHaveLength(1);
  const member = members[0];
  const context = await browser.newContext({ baseURL });
  context.setDefaultTimeout(15_000);
  let restore = false;
  const evidence: Record<string, unknown> = { agency1: 'Agency A', agency2: 'Agency B' };
  try {
    const hospital = await context.newPage();
    await signIn(hospital, 'hospital.b@saerosoft.com');
    const select = hospital.getByRole('combobox', { name: /^Financial agency\*/ });
    async function newForm() {
      const [body] = await Promise.all([
        hospital.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'FinancialAgencies').then(r => r.json()),
        hospital.goto('/partner/new'),
      ]);
      expect(body.errors).toBeUndefined();
      return body.data.financialAgencies;
    }
    const before = await newForm();
    expect(before).toHaveLength(2);
    expect(before.some((a: any) => a.id === original.agency.id)).toBe(true);
    const remaining = before.find((a: any) => a.id !== original.agency.id);
    await expect(select.locator(`option[value="${remaining.id}"]`)).toHaveText('Agency A Distribution');
    const requestId = await createHospitalReworkRequest(hospital, `TC-MG-019-${randomUUID().slice(0, 8)}`, undefined, original.agency.id, 'PEEK');
    async function requestSnapshot() {
      const [body] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
        page.goto(`/manager/requests/${requestId}`),
      ]);
      expect(body.errors).toBeUndefined();
      const details = body.data.request.details;
      return Object.fromEntries(['requestNo', 'financialAgencyUserId', 'quotedPrice', 'priceBaseAmount', 'priceCalculatedAt', 'status', 'agencyNames'].map(k => [k, details[k]]));
    }
    const saved = await requestSnapshot();
    expect(saved.financialAgencyUserId).toBe(original.agency.id);
    evidence.requestBefore = saved;
    await test.step('Deactivate only Hospital B membership in Agency B', async () => {
      await agencyB();
      const row = page.getByRole('row').filter({ hasText: 'hospital.b@saerosoft.com' });
      await row.getByRole('button', { name: 'Deactivate', exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: 'Deactivate this agency membership?', exact: true });
      restore = true;
      await confirmation.getByRole('button', { name: 'Deactivate membership', exact: true }).click();
      await expect(confirmation).toBeHidden();
      const current = (await agencyB()).agency;
      expect(current.members.find((m: any) => m.membershipId === member.membershipId).active).toBe(false);
    });
    await test.step('Fresh Partner form excludes Agency B and automatically selects Agency A', async () => {
      const available = await newForm();
      expect(available.map((a: any) => a.id)).toEqual([remaining.id]);
      await expect(select.locator(`option[value="${original.agency.id}"]`)).toHaveCount(0);
      await expect(select).toHaveValue(remaining.id);
      await expect(select.locator('option:checked')).toHaveText('Agency A Distribution');
      evidence.selectedAgency = await select.locator('option:checked').innerText();
      await select.scrollIntoViewIfNeeded();
      await test.info().attach('remaining-agency-auto-selected', { body: await hospital.screenshot(), contentType: 'image/png' });
    });
    await test.step('Previously submitted request retains its saved payer and quote', async () => {
      const after = await requestSnapshot();
      expect(after).toEqual(saved);
      evidence.requestAfter = after;
    });
  } finally {
    try {
      if (restore) {
        const response = await page.request.post(original.endpoint, {
          headers: { authorization: original.authorization, 'content-type': 'application/json' },
          data: { operationName: 'AddAgencyMember',
            query: 'mutation AddAgencyMember($input: AddAgencyMemberInput!) { addAgencyMember(input: $input) { id } }',
            variables: { input: { agencyUserId: original.agency.id, memberUserId: member.memberUserId,
              pricePolicy: member.pricePolicy, customAdjustmentPercent: member.customAdjustmentPercent } },
          },
        });
        expect(response.ok()).toBe(true);
        expect((await response.json()).errors).toBeUndefined();
        const restored = (await agencyB()).agency.members.filter((m: any) => m.memberUserId === member.memberUserId && m.active);
        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({ pricePolicy: member.pricePolicy, customAdjustmentPercent: member.customAdjustmentPercent });
        evidence.restored = true;
      }
      await test.info().attach('connection-results', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      console.log(JSON.stringify(evidence));
    } finally { await context.close(); }
  }
});
