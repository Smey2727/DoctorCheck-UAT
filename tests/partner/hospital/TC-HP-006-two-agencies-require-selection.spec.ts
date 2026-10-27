import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { waitForGraphqlResponse } from '../../helpers/graphql';
import { signIn, USERS } from '../../helpers/auth';
import { prepareHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

// Hospital B has a historical Agency A connection and one active Agency B connection.
test('TC-HP-006: Hospital B submits with its active agency, excluding its inactive historical connection', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const managerContext = await browser.newContext({ baseURL });
  managerContext.setDefaultTimeout(15_000);
  try {
    const manager = await managerContext.newPage();
    await signIn(manager, USERS.manager);
    async function agencyRecord(name: string) {
      await manager.goto('/manager/agencies');
      const [response] = await Promise.all([
        manager.waitForResponse(
          async (r) =>
            r.url().endsWith('/graphql') &&
            r.request().postDataJSON()?.operationName === 'Agency' &&
            (await r.json().catch(() => null))?.data?.agency?.displayName === name,
        ),
        manager
          .getByRole('button', { name: new RegExp('^' + name + ' ' + name + ' Distribution ') })
          .click(),
      ]);
      const body = await response.json();
      expect(body.errors).toBeUndefined();
      return body.data.agency;
    }
    const agencyA = await agencyRecord('Agency A');
    const agencyB = await agencyRecord('Agency B');
    const hospitalUser = await signIn(page, 'hospital.b@saerosoft.com');
    for (const [agency, active] of [
      [agencyA, false],
      [agencyB, true],
    ] as const) {
      const connections = agency.members.filter(
        (member: any) => member.memberUserId === hospitalUser.id,
      );
      expect(connections).toHaveLength(1);
      expect(connections[0].active).toBe(active);
    }
    const code = 'TC-HP-006-' + randomUUID().slice(0, 8);
    const ct = { ...syntheticCtRoundTwo, name: code + '-synthetic-ct.zip' };
    await prepareHospitalReworkRequest(page, code, ct, agencyB.id, 'PEEK');
    await expect(
      page.getByRole('textbox', { name: /^Hospital Set from your account/ }),
    ).toHaveValue('Hospital B Medical Center');
    const assignedAgency = page.getByRole('textbox', { name: /^Financial agency/ });
    await expect(assignedAgency).toHaveValue('Agency B Distribution');
    await expect(assignedAgency).toBeDisabled();
    await expect(page.getByRole('combobox', { name: /Financial agency/i })).toHaveCount(0);
    await expect(page.getByText('Agency A Distribution', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
    const confirmation = page.getByRole('alertdialog', {
      name: 'Submit this request?',
      exact: true,
    });
    await confirmation
      .getByRole('checkbox', { name: /^I reviewed the case details and files/ })
      .check();
    await confirmation.getByRole('button', { name: 'Submit request', exact: true }).click();
    await expect(page).toHaveURL(/\/partner\/requests\/REQ-\d{4}-\d+/);
    const requestId = new URL(page.url()).pathname.split('/').pop()!;
    // Let the initial detail query render before testing persistence with a reload.
    await expect(page.getByRole('heading', { name: requestId, exact: true })).toBeVisible();
    const [persisted] = await Promise.all([
      waitForGraphqlResponse(page, 'Request').then((response) => response.json()),
      page.reload(),
    ]);
    expect(persisted.errors).toBeUndefined();
    expect(persisted.data.request.details).toMatchObject({
      requestNo: requestId,
      status: 'SUBMITTED',
      financialAgencyUserId: agencyB.id,
      hospital: 'Hospital B Medical Center',
    });
    expect(persisted.data.request.details.financialAgencyUserId).not.toBe(agencyA.id);
    await expect(
      page
        .getByRole('heading', { name: requestId, exact: true })
        .locator('..')
        .getByRole('button', { name: 'Submitted', exact: true }),
    ).toBeVisible();
    const billing = page
      .getByRole('term')
      .filter({ hasText: /^Billing account$/ })
      .locator('xpath=following-sibling::dd[1]');
    await expect(billing).toContainText('Agency B Distribution');
    const result = {
      requestId,
      activeAgency: agencyB.organizationName,
      inactiveAgencyExcluded: agencyA.organizationName,
      persistedStatus: 'SUBMITTED',
      billing: await billing.innerText(),
    };
    test.info().annotations.push({ type: 'request', description: requestId });
    await test
      .info()
      .attach('active-agency-request', { body: await page.screenshot(), contentType: 'image/png' });
    await test.info().attach('agency-assignment-results', {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    console.log(JSON.stringify(result));
  } finally {
    await managerContext.close();
  }
});
