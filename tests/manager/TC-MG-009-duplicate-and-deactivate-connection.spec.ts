import { expect, Page, test } from '@playwright/test';
import { waitForGraphqlResponse } from '../helpers/graphql';
import { signIn, USERS } from '../helpers/auth';

const HOSPITAL_LOGIN = 'hospital.a@saerosoft.com';
const OLD_REQUEST = 'REQ-2026-0057';
const AGENCY = 'Agency A';
const ADD_MEMBER = `mutation AddAgencyMember($input: AddAgencyMemberInput!) {
  addAgencyMember(input: $input) { id members { membershipId memberUserId active pricePolicy customAdjustmentPercent } }
}`;

async function agencyRecord(page: Page) {
  const [response] = await Promise.all([
    page.waitForResponse(async (r) => {
      if (!r.url().endsWith('/graphql') || r.request().postDataJSON()?.operationName !== 'Agency') {
        return false;
      }
      const body = await r.json().catch(() => null);
      return body?.data?.agency?.displayName === AGENCY;
    }),
    (async () => {
      await page.goto('/manager/agencies');
      await page.getByRole('button', { name: /^Agency A Agency A Distribution / }).click();
    })(),
  ]);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  await expect(page.getByRole('heading', { name: AGENCY, exact: true })).toBeVisible();
  return {
    agency: body.data.agency,
    endpoint: response.url(),
    authorization: (await response.request().allHeaders()).authorization,
  };
}
function memberRow(page: Page) {
  return page.getByRole('row').filter({
    has: page.getByRole('cell', { name: new RegExp(HOSPITAL_LOGIN.replaceAll('.', '\\.')) }),
  });
}
function billingAccount(page: Page) {
  return page
    .getByRole('term')
    .filter({ hasText: /^Billing account$/ })
    .locator('xpath=following-sibling::dd[1]');
}
async function newFormAgency(page: Page) {
  const [body] = await Promise.all([
    waitForGraphqlResponse(page, 'FinancialAgency').then((response) => response.json()),
    page.goto('/partner/new'),
  ]);
  expect(body.errors).toBeUndefined();
  await expect(page.getByRole('heading', { name: 'New Request', exact: true })).toBeVisible();
  return body.data.financialAgency;
}
async function requestSnapshot(page: Page) {
  const [body] = await Promise.all([
    waitForGraphqlResponse(page, 'Request').then((response) => response.json()),
    page.goto(`/manager/requests/${OLD_REQUEST}`),
  ]);
  expect(body.errors).toBeUndefined();
  const fields = body.data.request.details;
  expect(fields.requestNo).toBe(OLD_REQUEST);
  return {
    financialAgencyUserId: fields.financialAgencyUserId,
    agencyNames: fields.agencyNames,
    lines: fields.lines,
    quotedPrice: fields.quotedPrice,
    priceCurrency: fields.priceCurrency,
    priceCalculatedAt: fields.priceCalculatedAt,
    status: fields.status,
    statusHistory: fields.statusHistory,
  };
}

// Seeded Hospital A / Agency A membership and historical request. Restore the
// connection and its original pricing policy even when an assertion fails.
test('TC-MG-009: Duplicate connections are blocked and deactivation preserves the old request agency', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, USERS.manager);
  const original = await agencyRecord(page);
  const connections = original.agency.members.filter(
    (m: any) => m.memberEmail === HOSPITAL_LOGIN && m.active,
  );
  expect(connections).toHaveLength(1);
  const member = connections[0];
  const before = await requestSnapshot(page);
  expect(before.financialAgencyUserId).toBe(original.agency.id);
  const hospitalContext = await browser.newContext({ baseURL });
  hospitalContext.setDefaultTimeout(15_000);
  const addInput = {
    agencyUserId: original.agency.id,
    memberUserId: member.memberUserId,
    pricePolicy: member.pricePolicy,
    customAdjustmentPercent: member.customAdjustmentPercent,
  };
  const addConnection = async () => {
    const response = await page.request.post(original.endpoint, {
      headers: { authorization: original.authorization, 'content-type': 'application/json' },
      data: { operationName: 'AddAgencyMember', query: ADD_MEMBER, variables: { input: addInput } },
    });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  let restore = false;
  try {
    const hospitalPage = await hospitalContext.newPage();
    await signIn(hospitalPage, HOSPITAL_LOGIN);
    const available = await newFormAgency(hospitalPage);
    expect(available.id).toBe(original.agency.id);
    await expect(hospitalPage.getByRole('textbox', { name: /^Financial agency/ })).toHaveValue(
      original.agency.organizationName,
    );
    await expect(hospitalPage.getByRole('textbox', { name: /^Financial agency/ })).toBeDisabled();
    await hospitalPage.goto(`/partner/requests/${OLD_REQUEST}`);
    await expect(
      hospitalPage.getByRole('heading', { name: OLD_REQUEST, exact: true }),
    ).toBeVisible();
    const savedBilling = await billingAccount(hospitalPage).innerText();
    expect(savedBilling).toContain(original.agency.organizationName);
    await test.step('Existing pair cannot be added twice in the UI or server', async () => {
      await agencyRecord(page);
      await expect(memberRow(page)).toHaveCount(1);
      await page.getByRole('button', { name: '+ Add user', exact: true }).click();
      const dialog = page.getByRole('dialog', {
        name: 'Add a partner user to Agency A',
        exact: true,
      });
      await dialog.getByRole('button', { name: 'Partner member', exact: true }).click();
      await dialog
        .getByRole('searchbox', {
          name: 'Find a partner',
          exact: true,
        })
        .fill(HOSPITAL_LOGIN);
      await expect(
        dialog.getByRole('button', { name: new RegExp(HOSPITAL_LOGIN.replaceAll('.', '\\.')) }),
      ).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Partner member', exact: true })).toHaveText(
        'Select partner',
      );
      await expect(dialog.getByRole('button', { name: 'Add user', exact: true })).toBeDisabled();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      const duplicate = await addConnection();
      expect(duplicate.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: 'This member is already held by the agency.' }),
        ]),
      );
      const unchanged = (await agencyRecord(page)).agency;
      expect(unchanged.members).toEqual(original.agency.members);
    });
    await test.step('Deactivate the connection while preserving its history', async () => {
      await memberRow(page).getByRole('button', { name: 'Deactivate', exact: true }).click();
      const confirmation = page.getByRole('alertdialog', {
        name: 'Deactivate this agency membership?',
        exact: true,
      });
      restore = true;
      await confirmation
        .getByRole('button', { name: 'Deactivate membership', exact: true })
        .click();
      await expect(confirmation).toBeHidden();
      const deactivated = (await agencyRecord(page)).agency;
      expect(
        deactivated.members.filter((m: any) => m.memberUserId === member.memberUserId && m.active),
      ).toHaveLength(0);
      expect(
        deactivated.members.find((m: any) => m.membershipId === member.membershipId),
      ).toMatchObject({ active: false });
    });
    await test.step('New form excludes the agency but the old request retains its saved agency', async () => {
      const after = await newFormAgency(hospitalPage);
      expect(after).toBeNull();
      await expect(hospitalPage.getByRole('textbox', { name: /^Financial agency/ })).toHaveCount(0);
      expect(await requestSnapshot(page)).toEqual(before);
      await hospitalPage.goto(`/partner/requests/${OLD_REQUEST}`);
      await expect(
        hospitalPage.getByRole('heading', { name: OLD_REQUEST, exact: true }),
      ).toBeVisible();
      await expect(billingAccount(hospitalPage)).toHaveText(savedBilling);
    });
    test.info().annotations.push({ type: 'request', description: OLD_REQUEST });
  } finally {
    try {
      if (restore) {
        test.setTimeout(test.info().timeout + 30_000);
        await test.step('Restore the original connection and pricing policy', async () => {
          const current = (await agencyRecord(page)).agency;
          if (
            !current.members.some((m: any) => m.memberUserId === member.memberUserId && m.active)
          ) {
            expect((await addConnection()).errors).toBeUndefined();
          }
          const restored = (await agencyRecord(page)).agency.members.filter(
            (m: any) => m.memberUserId === member.memberUserId && m.active,
          );
          expect(restored).toHaveLength(1);
          expect(restored[0]).toMatchObject({
            pricePolicy: member.pricePolicy,
            customAdjustmentPercent: member.customAdjustmentPercent,
          });
          const verifyPage = await hospitalContext.newPage();
          expect((await newFormAgency(verifyPage)).id).toBe(original.agency.id);
        });
      }
    } finally {
      await hospitalContext.close();
    }
  }
});
