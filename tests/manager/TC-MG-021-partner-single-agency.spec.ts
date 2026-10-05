import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';

const PARTNER_LOGIN = 'hospital.a@saerosoft.com';
const SOURCE_AGENCY = 'Agency A';
const TARGET_AGENCY = 'Agency B';
const ADD_MEMBER = `mutation AddAgencyMember($input: AddAgencyMemberInput!) {
  addAgencyMember(input: $input) { id members { membershipId memberUserId active pricePolicy customAdjustmentPercent } }
}`;

async function loadAgency(page: Page, name: string, initial = false) {
  const [response] = await Promise.all([
    page.waitForResponse(async r => {
      if (!r.url().endsWith('/graphql') || r.request().postDataJSON()?.operationName !== 'Agency') return false;
      return (await r.json().catch(() => null))?.data?.agency?.displayName === name;
    }),
    (async () => {
      await page.goto('/manager/agencies');
      if (name !== SOURCE_AGENCY) {
        await expect(page.getByRole('heading', { name: SOURCE_AGENCY, exact: true })).toBeVisible();
        await page.getByRole('button', { name: new RegExp(`^${name} ${name} Distribution`) }).click();
      }
    })(),
  ]);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  return { agency: body.data.agency, endpoint: response.url(), authorization: (await response.request().allHeaders()).authorization };
}

test('TC-MG-021: Non-agency Partner cannot be mapped to a second active Agency', async ({ page }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, USERS.manager);
  const original = await loadAgency(page, SOURCE_AGENCY, true);
  const existing = original.agency.members.filter((m: any) => m.memberEmail === PARTNER_LOGIN && m.active);
  expect(existing).toHaveLength(1);
  const member = existing[0];
  const target = await loadAgency(page, TARGET_AGENCY);
  expect(target.agency.members.filter((m: any) => m.memberUserId === member.memberUserId && m.active)).toHaveLength(0);
  let attempted = false;
  try {
    await page.getByRole('button', { name: '+ Add user', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Add a partner user to ${TARGET_AGENCY}`, exact: true });
    await dialog.getByRole('textbox', { name: 'Search by hospital, department, name, or email', exact: true }).fill(PARTNER_LOGIN);
    const candidate = dialog.getByRole('combobox', { name: 'Partner member', exact: true })
      .locator(`option[value="${member.memberUserId}"]`);
    // Capture actual availability; the server check still runs if the UI hides it.
    const offered = await candidate.count();
    await test.info().attach('second-agency-picker', { body: await page.screenshot(), contentType: 'image/png' });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    attempted = true;
    const response = await page.request.post(target.endpoint, {
      headers: { authorization: target.authorization, 'content-type': 'application/json' },
      data: { operationName: 'AddAgencyMember', query: ADD_MEMBER, variables: { input: {
        agencyUserId: target.agency.id, memberUserId: member.memberUserId,
        pricePolicy: member.pricePolicy, customAdjustmentPercent: member.customAdjustmentPercent,
      } } },
    });
    expect(response.ok()).toBe(true);
    const added = await response.json();
    // Reload through another agency to avoid a cached target response.
    const originalAfter = await loadAgency(page, SOURCE_AGENCY);
    const targetAfter = await loadAgency(page, TARGET_AGENCY);
    const activeSecond = targetAfter.agency.members.filter((m: any) => m.memberUserId === member.memberUserId && m.active);
    const result = { partner: PARTNER_LOGIN, existingAgency: SOURCE_AGENCY, attemptedAgency: TARGET_AGENCY,
      offeredInSecondAgencyPicker: offered > 0, errors: added.errors ?? null,
      secondActiveConnections: activeSecond.length, firstAgencyUnchanged: JSON.stringify(originalAfter.agency.members) === JSON.stringify(original.agency.members) };
    await test.info().attach('single-agency-result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify(result));
    expect.soft(added.errors, 'Server must reject mapping a Partner already held by another active Agency').toBeDefined();
    if (added.errors) {
      expect.soft(added.errors.some((error: any) => /agency|member|partner|connection/i.test(error.message))).toBe(true);
    }
    expect.soft(activeSecond, 'Partner must retain only its original active Agency').toHaveLength(0);
    expect(originalAfter.agency.members).toEqual(original.agency.members);
  } finally {
    if (attempted) {
      test.setTimeout(test.info().timeout + 30_000);
      await loadAgency(page, SOURCE_AGENCY);
      const current = (await loadAgency(page, TARGET_AGENCY)).agency;
      if (current.members.some((m: any) => m.memberUserId === member.memberUserId && m.active)) {
        const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: new RegExp(PARTNER_LOGIN.replaceAll('.', '\\.')) }) });
        await row.getByRole('button', { name: 'Deactivate', exact: true }).click();
        await page.getByRole('alertdialog', { name: 'Deactivate this agency membership?', exact: true })
          .getByRole('button', { name: 'Deactivate membership', exact: true }).click();
        await loadAgency(page, SOURCE_AGENCY);
        const restoredTarget = (await loadAgency(page, TARGET_AGENCY)).agency;
        expect(restoredTarget.members.filter((m: any) => m.memberUserId === member.memberUserId && m.active)).toHaveLength(0);
        const restoredOriginal = (await loadAgency(page, SOURCE_AGENCY)).agency;
        expect(restoredOriginal.members).toEqual(original.agency.members);
        console.log('Cleanup verified: Hospital A remains active under Agency A only.');
      }
    }
  }
});
