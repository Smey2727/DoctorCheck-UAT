import { expect, test } from '@playwright/test';
import { waitForGraphqlResponse } from '../helpers/graphql';
import { signIn, USERS } from '../helpers/auth';

// Current accounts have one active agency. Preserve the seeded request's frozen payer.
test('TC-MG-019: Deactivated agency is hidden and a replacement connection is assigned automatically', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, USERS.manager);
  async function agencyRecord(name = 'Agency B') {
    await page.goto('/manager/agencies');
    const [response] = await Promise.all([
      page.waitForResponse(async (r) => {
        if (
          !r.url().endsWith('/graphql') ||
          r.request().postDataJSON()?.operationName !== 'Agency'
        ) {
          return false;
        }
        return (await r.json().catch(() => null))?.data?.agency?.displayName === name;
      }),
      page.getByRole('button', { name: new RegExp(`^${name} ${name} Distribution `) }).click(),
    ]);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    return {
      agency: body.data.agency,
      endpoint: response.url(),
      authorization: (await response.request().allHeaders()).authorization,
    };
  }
  const agencyB = () => agencyRecord();
  const original = await agencyB();
  const replacement = (await agencyRecord('Agency A')).agency;
  const members = original.agency.members.filter(
    (m: any) => m.memberEmail === 'hospital.b@saerosoft.com' && m.active,
  );
  expect(members).toHaveLength(1);
  const member = members[0];
  const replacementMember = replacement.members.find(
    (m: any) => m.memberUserId === member.memberUserId,
  );
  expect(replacementMember.active).toBe(false);
  async function activate(agencyUserId: string, policy: any) {
    const response = await page.request.post(original.endpoint, {
      headers: { authorization: original.authorization, 'content-type': 'application/json' },
      data: {
        operationName: 'AddAgencyMember',
        query:
          'mutation AddAgencyMember($input: AddAgencyMemberInput!) { addAgencyMember(input: $input) { id } }',
        variables: {
          input: {
            agencyUserId,
            memberUserId: member.memberUserId,
            pricePolicy: policy.pricePolicy,
            customAdjustmentPercent: policy.customAdjustmentPercent,
          },
        },
      },
    });
    expect(response.ok()).toBe(true);
    expect((await response.json()).errors).toBeUndefined();
  }
  const context = await browser.newContext({ baseURL });
  context.setDefaultTimeout(15_000);
  let restore = false;
  let replacementActivated = false;
  const evidence: Record<string, unknown> = { agency1: 'Agency A', agency2: 'Agency B' };
  try {
    const hospital = await context.newPage();
    await signIn(hospital, 'hospital.b@saerosoft.com');
    const select = hospital.getByRole('textbox', { name: /^Financial agency/ });
    async function newForm() {
      const [body] = await Promise.all([
        waitForGraphqlResponse(hospital, 'FinancialAgency').then((response) => response.json()),
        hospital.goto('/partner/new'),
      ]);
      expect(body.errors).toBeUndefined();
      return body.data.financialAgency;
    }
    const before = await newForm();
    expect(before.id).toBe(original.agency.id);
    await expect(select).toHaveValue(original.agency.organizationName);
    await expect(select).toBeDisabled();
    const requestId = 'REQ-2026-0061';
    async function requestSnapshot() {
      const [body] = await Promise.all([
        waitForGraphqlResponse(page, 'Request').then((response) => response.json()),
        page.goto(`/manager/requests/${requestId}`),
      ]);
      expect(body.errors).toBeUndefined();
      const details = body.data.request.details;
      return {
        requestNo: details.requestNo,
        financialAgencyUserId: details.financialAgencyUserId,
        quotedPrice: details.quotedPrice,
        lines: details.lines,
        priceCalculatedAt: details.priceCalculatedAt,
        status: details.status,
        agencyNames: details.agencyNames,
      };
    }
    const saved = await requestSnapshot();
    expect(saved.financialAgencyUserId).toBe(original.agency.id);
    evidence.requestBefore = saved;
    await test.step('Deactivate only Hospital B membership in Agency B', async () => {
      await agencyB();
      const row = page.getByRole('row').filter({ hasText: 'hospital.b@saerosoft.com' });
      await row.getByRole('button', { name: 'Deactivate', exact: true }).click();
      const confirmation = page.getByRole('alertdialog', {
        name: 'Deactivate this agency membership?',
        exact: true,
      });
      restore = true;
      await confirmation
        .getByRole('button', { name: 'Deactivate membership', exact: true })
        .click();
      await expect(confirmation).toBeHidden();
      const current = (await agencyB()).agency;
      expect(current.members.find((m: any) => m.membershipId === member.membershipId).active).toBe(
        false,
      );
    });
    await test.step('Deactivated Agency B disappears from the fresh Partner form', async () => {
      expect(await newForm()).toBeNull();
      await expect(select).toHaveCount(0);
      expect(await requestSnapshot()).toEqual(saved);
    });
    await test.step('Connect Agency A and verify automatic assignment on a fresh form', async () => {
      replacementActivated = true;
      await activate(replacement.id, replacementMember);
      const available = await newForm();
      expect(available.id).toBe(replacement.id);
      await expect(select).toHaveValue(replacement.organizationName);
      await expect(select).toBeDisabled();
      evidence.selectedAgency = await select.inputValue();
      await select.scrollIntoViewIfNeeded();
      await test.info().attach('remaining-agency-auto-selected', {
        body: await hospital.screenshot(),
        contentType: 'image/png',
      });
    });
    await test.step('Previously submitted request retains its saved payer and quote', async () => {
      const after = await requestSnapshot();
      expect(after).toEqual(saved);
      evidence.requestAfter = after;
    });
  } finally {
    test.setTimeout(test.info().timeout + 30_000);
    try {
      if (replacementActivated) {
        const current = (await agencyRecord('Agency A')).agency;
        if (current.members.some((m: any) => m.memberUserId === member.memberUserId && m.active)) {
          await page
            .getByRole('row')
            .filter({ hasText: 'hospital.b@saerosoft.com' })
            .getByRole('button', { name: 'Deactivate', exact: true })
            .click();
          const confirmation = page.getByRole('alertdialog', {
            name: 'Deactivate this agency membership?',
            exact: true,
          });
          await confirmation
            .getByRole('button', { name: 'Deactivate membership', exact: true })
            .click();
          await expect(confirmation).toBeHidden();
        }
        const restoredA = (await agencyRecord('Agency A')).agency.members.find(
          (m: any) => m.memberUserId === member.memberUserId,
        );
        expect(restoredA).toMatchObject({
          active: false,
          pricePolicy: replacementMember.pricePolicy,
          customAdjustmentPercent: replacementMember.customAdjustmentPercent,
        });
      }
      if (restore) {
        const response = await page.request.post(original.endpoint, {
          headers: { authorization: original.authorization, 'content-type': 'application/json' },
          data: {
            operationName: 'AddAgencyMember',
            query:
              'mutation AddAgencyMember($input: AddAgencyMemberInput!) { addAgencyMember(input: $input) { id } }',
            variables: {
              input: {
                agencyUserId: original.agency.id,
                memberUserId: member.memberUserId,
                pricePolicy: member.pricePolicy,
                customAdjustmentPercent: member.customAdjustmentPercent,
              },
            },
          },
        });
        expect(response.ok()).toBe(true);
        expect((await response.json()).errors).toBeUndefined();
        const restored = (await agencyB()).agency.members.filter(
          (m: any) => m.memberUserId === member.memberUserId && m.active,
        );
        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({
          pricePolicy: member.pricePolicy,
          customAdjustmentPercent: member.customAdjustmentPercent,
        });
        evidence.restored = true;
      }
      await test.info().attach('connection-results', {
        body: JSON.stringify(evidence, null, 2),
        contentType: 'application/json',
      });
      console.log(JSON.stringify(evidence));
    } finally {
      await context.close();
    }
  }
});
