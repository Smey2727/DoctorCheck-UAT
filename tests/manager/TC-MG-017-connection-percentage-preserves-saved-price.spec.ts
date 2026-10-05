import { randomUUID } from 'node:crypto';
import { createHospitalReworkRequest } from '../helpers/requests';
import { syntheticCtRoundTwo } from '../helpers/synthetic-ct';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';

const HOSPITAL_LOGIN = 'hospital.a@saerosoft.com';
const OLD_REQUEST = 'REQ-2026-0057';
const AGENCY = 'Agency A';

async function agencyRecord(page: Page) {
  const [response] = await Promise.all([
    page.waitForResponse(async r => {
      if (!r.url().endsWith('/graphql') || r.request().postDataJSON()?.operationName !== 'Agency') return false;
      const body = await r.json().catch(() => null);
      return body?.data?.agency?.displayName === AGENCY;
    }),
    page.goto('/manager/agencies'),
  ]);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  await expect(page.getByRole('heading', { name: AGENCY, exact: true })).toBeVisible();
  return { agency: body.data.agency, endpoint: response.url(), authorization: (await response.request().allHeaders()).authorization };
}
function memberRow(page: Page) {
  return page.getByRole('row').filter({ has: page.getByRole('cell', { name: new RegExp(HOSPITAL_LOGIN.replaceAll('.', '\\.')) }) });
}
async function requestSnapshot(page: Page) {
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    page.goto(`/manager/requests/${OLD_REQUEST}`),
  ]);
  expect(body.errors).toBeUndefined();
  const fields = body.data.request.details;
  expect(fields.requestNo).toBe(OLD_REQUEST);
  return Object.fromEntries(['financialAgencyUserId', 'agencyNames', 'priceBaseAmount', 'quotedPrice',
    'priceCurrency', 'priceCalculatedAt', 'status', 'statusHistory'].map(key => [key, fields[key]]));
}

// Submitted pricing remains frozen through resubmission; changed discounts apply only to new requests.
test('TC-MG-017: Connection percentage changes apply only to new requests and preserve submitted pricing through resubmission', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  await signIn(page, USERS.manager);
  const original = (await agencyRecord(page)).agency;
  const member = original.members.find((m: any) => m.memberEmail === HOSPITAL_LOGIN && m.active);
  expect(member).toBeDefined();
  const historic = await requestSnapshot(page);
  const hospitalContext = await browser.newContext({ baseURL });
  const counselorContext = await browser.newContext({ baseURL });
  page.setDefaultTimeout(15_000);
  hospitalContext.setDefaultTimeout(15_000);
  counselorContext.setDefaultTimeout(15_000);
  let changed = false;
  async function snapshot(requestId: string) {
    const [body] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
      page.goto(`/manager/requests/${requestId}`),
    ]);
    expect(body.errors).toBeUndefined();
    const details = body.data.request.details;
    return Object.fromEntries(['requestNo', 'financialAgencyUserId', 'priceBaseAmount', 'quotedPrice',
      'priceCurrency', 'priceAdjustmentType', 'priceAdjustmentPercent', 'priceAdjustmentAmount', 'priceCalculatedAt'].map(key => [key, details[key]]));
  }
  async function savePolicy(policy: string, percent: string | null) {
    await agencyRecord(page);
    const row = memberRow(page);
    await row.getByRole('combobox').selectOption(policy);
    if (percent !== null) await row.getByRole('textbox', { name: 'Custom adjustment for Hospital A', exact: true }).fill(percent);
    const [body] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql') && /mutation/.test(r.request().postDataJSON()?.query ?? '')).then(r => r.json()),
      row.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    expect(body.errors).toBeUndefined();
    return (await agencyRecord(page)).agency.members.find((m: any) => m.membershipId === member.membershipId);
  }
  const evidence: Record<string, unknown> = {};
  try {
    const hospital = await hospitalContext.newPage();
    await signIn(hospital, HOSPITAL_LOGIN);
    const code = `TC-MG-017-${randomUUID().slice(0, 8)}`;
    const beforeId = await createHospitalReworkRequest(hospital, `${code}-before`, undefined, original.id, 'PEEK');
    const before = await snapshot(beforeId);
    expect(before.financialAgencyUserId).toBe(original.id);
    expect(Number(before.priceBaseAmount)).toBeGreaterThan(0);
    const percent = Number(before.priceAdjustmentPercent) === -17 ? '-13' : '-17';
    const expectedPrice = (Number(before.priceBaseAmount) * (1 + Number(percent) / 100)).toFixed(2);
    expect(expectedPrice).not.toBe(before.quotedPrice);
    evidence.before = before;
    await test.step('Save Custom percentage and preserve both existing submitted quotes', async () => {
      await agencyRecord(page);
      const customOption = await memberRow(page).getByRole('combobox').getByRole('option', { name: 'Custom', exact: true }).getAttribute('value');
      expect(customOption).toBeTruthy();
      changed = true;
      const saved = await savePolicy(customOption!, percent);
      expect(saved.pricePolicy).toBe(customOption);
      expect(Number(saved.customAdjustmentPercent)).toBe(Number(percent));
      expect(await snapshot(beforeId)).toEqual(before);
      expect(await requestSnapshot(page)).toEqual(historic);
      evidence.customPercent = percent;
      evidence.expectedPrice = expectedPrice;
    });
    let newId: string;
    await test.step('A newly submitted request uses the updated connection percentage', async () => {
      newId = await createHospitalReworkRequest(hospital, `${code}-after`, undefined, original.id, 'PEEK');
      const fresh = await snapshot(newId);
      evidence.newRequest = fresh;
      expect(fresh.financialAgencyUserId).toBe(original.id);
      expect(fresh.priceBaseAmount).toBe(before.priceBaseAmount);
      expect.soft(fresh.quotedPrice).toBe(expectedPrice);
      expect.soft(Number(fresh.priceAdjustmentPercent)).toBe(Number(percent));
      expect(await snapshot(beforeId)).toEqual(before);
    });
    await test.step('Resubmission preserves the original price, discount, calculation timestamp and payer', async () => {
      const counselor = await counselorContext.newPage();
      await signIn(counselor, USERS.counselor);
      await counselor.goto('/counselor/requests');
      await counselor.getByRole('searchbox', { name: /^Search request no\./ }).fill(beforeId);
      const row = counselor.getByRole('row').filter({ has: counselor.getByRole('cell', { name: beforeId, exact: true }) });
      const claim = row.getByRole('button', { name: 'Claim', exact: true });
      await claim.click();
      await expect(claim).toBeHidden();
      await counselor.goto(`/counselor/requests/${beforeId}`);
      await counselor.getByRole('button', { name: 'Start review', exact: true }).click();
      const note = counselor.getByRole('textbox', { name: 'Optional note for the status history', exact: true });
      await note.fill(`${code}: synthetic pricing resubmission test`);
      await note.locator('..').getByRole('button', { name: 'Start review', exact: true }).click();
      await expect(note).toBeHidden();
      await counselor.getByRole('button', { name: 'Request rework', exact: true }).click();
      await counselor.getByRole('textbox', { name: 'Explain what the partner needs to fix', exact: true }).fill(`${code}: Replace the synthetic CT for the pricing resubmission test.`);
      await counselor.getByRole('button', { name: 'Send rework request', exact: true }).click();
      await expect(counselor.getByRole('heading', { name: beforeId, exact: true }).locator('..').getByRole('button', { name: 'Rework requested', exact: true })).toBeVisible();
      await hospital.goto(`/partner/requests/${beforeId}`);
      await hospital.getByRole('link', { name: 'Fix & resubmit', exact: true }).click();
      await hospital.locator('input[type="file"][accept*=".dcm"]').setInputFiles({ ...syntheticCtRoundTwo, name: `${code}-round2.zip` });
      await hospital.getByRole('button', { name: 'Resubmit request', exact: true }).first().click();
      const confirmation = hospital.getByRole('alertdialog');
      await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
      await confirmation.getByRole('button', { name: 'Resubmit request', exact: true }).click();
      await expect(hospital).toHaveURL(new RegExp(`/partner/requests/${beforeId}$`));
      await expect(hospital.getByRole('heading', { name: beforeId, exact: true }).locator('..')
        .getByRole('button', { name: 'Submitted', exact: true })).toBeVisible();
      await hospital.reload();
      await expect(hospital.getByRole('heading', { name: beforeId, exact: true }).locator('..')
        .getByRole('button', { name: 'Submitted', exact: true })).toBeVisible();
      const resubmitted = await snapshot(beforeId);
      evidence.resubmitted = resubmitted;
      expect(resubmitted).toEqual(before);
      expect(await requestSnapshot(page)).toEqual(historic);
    });
  } finally {
    try {
      if (changed) {
        const restored = await savePolicy(member.pricePolicy, member.customAdjustmentPercent);
        expect(restored).toMatchObject({ pricePolicy: member.pricePolicy, customAdjustmentPercent: member.customAdjustmentPercent, active: true });
        evidence.restored = true;
      }
      await test.info().attach('connection-pricing-results', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      console.log(JSON.stringify(evidence));
    } finally {
      for (const hospitalPage of hospitalContext.pages()) {
        if (!hospitalPage.isClosed()) await test.info().attach('hospital-state', { body: await hospitalPage.locator('body').ariaSnapshot(), contentType: 'text/plain' });
      }
      await hospitalContext.close(); await counselorContext.close();
    }
  }
});
