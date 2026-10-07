from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = (root / 'tests/manager/TC-MG-012-complete-shipment.spec.ts').read_text(encoding='utf-8-sig')
own = (root / 'tests/partner/agency/TC-AG-002-own-request.spec.ts').read_text(encoding='utf-8-sig')
auth = (root / 'tests/partner/agency/TC-AG-008-bills-match-selected-payer.spec.ts').read_text(encoding='utf-8-sig')
login = auth[auth.index('async function login('):auth.index('\nasync function billing(')].replace('TC-AG-008', 'TC-AG-009')
form = own[own.index("  await page.goto('/partner/new');"):own.index("  await test.step('Submit and verify persisted price, status and billing'")]
form = form.replace('TC-AG-002', 'TC-AG-009').replace('    await signOut(page);\n', '')
form = form.replace("    throw new Error('TC-AG-009 BLOCKED: PBH / PEEK has no calculated quote or Small size; submission and saved payer cannot be verified.');", "    const reason = 'TC-AG-009 BLOCKED: PBH / PEEK / Small pricing is unavailable; full flow cannot start.';\n    test.info().annotations.push({ type: 'blocked', description: reason });\n    test.skip(true, reason);")
create = '''async function createAgencyOwnRequest(page: Page, caseCode: string) {
''' + form + '''
  await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
  const confirmation = page.getByRole('alertdialog', { name: 'Submit this request?', exact: true });
  await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
  await confirmation.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page).toHaveURL(/\\/partner\\/requests\\/REQ-\\d{4}-\\d+/);
  const requestId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByRole('heading', { name: requestId, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submitted', exact: true })).toBeVisible();
  return requestId;
}

'''
source = source.replace("import { createHospitalReworkRequest } from '../helpers/requests';\n", '')
source = source.replace("from '../helpers/", "from '../../helpers/")
source = source.replace('TC-MG-012', 'TC-AG-009')
source = source.replace('Complete shipment changes Shipment and Request from SHIPPED to COMPLETED', 'Agency own request follows the full flow to COMPLETED and is billed directly at 900000 KRW')
source = source.replace('test.setTimeout(180_000)', 'test.setTimeout(300_000)')
source = source.replace('await signIn(hospitalPage, USERS.hospital);', 'const agencyUser = await login(hospitalPage, USERS.agency);')
source = source.replace('await signIn(page, USERS.counselor);', 'await login(page, USERS.counselor);')
source = source.replace('await signIn(manager, USERS.manager);', 'await login(manager, USERS.manager);')
old = '''const requestId = await createHospitalReworkRequest(hospitalPage, caseCode, {
      ...syntheticCtRoundTwo, name: `${caseCode}-ct.zip`,
    });'''
assert old in source
source = source.replace(old, 'const requestId = await createAgencyOwnRequest(hospitalPage, caseCode);')
source = source.replace('hospitalContext', 'agencyContext').replace('hospitalPage', 'agencyPage')
source = source.replace('// TC-AG-009: Use an independent synthetic request to verify shipment completion.', '// TC-AG-009: Synthetic Agency own request; one login per role and no real shipment or payment.')

bill = '''
      await test.step('Issue the base-price bill directly to the Agency and verify it in Agency Bills', async () => {
        const [requestBody] = await Promise.all([
          manager.waitForResponse(r => r.url().endsWith('/graphql')
            && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
          operations(),
        ]);
        expect(requestBody.errors).toBeUndefined();
        const details = requestBody.data.request.details;
        expect(details).toMatchObject({ requestNo: requestId, status: 'COMPLETED', product: 'PBH',
          material: 'PEEK', priceSizeBucketLabel: 'Small', financialAgencyUserId: null, priceCurrency: 'KRW' });
        expect(Number(details.priceBaseAmount)).toBe(900000);
        expect(Number(details.quotedPrice)).toBe(900000);
        expect(Number(details.priceAdjustmentPercent ?? 0)).toBe(0);
        const period = { year: Number(shipDate.slice(0, 4)), month: Number(shipDate.slice(5, 7)) };
        const [capture] = await Promise.all([
          manager.waitForResponse(r => r.url().endsWith('/graphql')
            && r.request().postDataJSON()?.operationName === 'BillingSummary')
            .then(async r => ({ url: r.url(), query: r.request().postDataJSON(),
              headers: r.request().headers().authorization ? { authorization: r.request().headers().authorization } : {},
              body: await r.json() })),
          manager.getByRole('link', { name: /Billing row/ }).click(),
        ]);
        expect(capture.body.errors).toBeUndefined();
        async function savedBill() {
          const response = await manager.request.post(capture.url, {
            headers: capture.headers, data: { ...capture.query, variables: period },
          });
          expect(response.ok()).toBe(true);
          const body = await response.json();
          expect(body.errors).toBeUndefined();
          const group = body.data.billingSummary.directPartnerGroups.find((g: any) =>
            g.requests.some((r: any) => r.requestNo === requestId));
          expect(group).toMatchObject({ billedToUserId: agencyUser.id, viaAgency: false });
          const invoice = group.requests.find((r: any) => r.requestNo === requestId);
          expect(Number(invoice.calculatedAmount)).toBe(900000);
          expect(invoice.currency).toBe('KRW');
          return { group, invoice };
        }
        const initial = await savedBill();
        await manager.getByRole('row').filter({ hasText: initial.group.billedToName })
          .getByRole('button', { name: 'Open', exact: true }).click();
        const card = manager.getByRole('link', { name: requestId, exact: true })
          .locator('xpath=ancestor::div[.//button[normalize-space()="Issue invoice"]][1]');
        await expect(card.getByRole('textbox', { name: /^Invoice amount/ })).toHaveValue('900000.00');
        await card.getByRole('button', { name: 'Issue invoice', exact: true }).click();
        const issue = manager.getByRole('alertdialog', { name: 'Issue this invoice?', exact: true });
        await issue.getByRole('checkbox').check();
        await issue.getByRole('button', { name: 'Issue invoice', exact: true }).click();
        await expect(issue).toBeHidden();
        const issued = await savedBill();
        expect(issued.invoice).toMatchObject({ invoiceStatus: 'INVOICED', amount: '900000.00' });

        const [agencyBilling] = await Promise.all([
          partnerPage.waitForResponse(r => r.url().endsWith('/graphql')
            && r.request().postDataJSON()?.operationName === 'BillingSummary')
            .then(async r => ({ url: r.url(), query: r.request().postDataJSON(),
              headers: r.request().headers().authorization ? { authorization: r.request().headers().authorization } : {} })),
          partnerPage.goto('/partner/billing'),
        ]);
        const response = await partnerPage.request.post(agencyBilling.url, {
          headers: agencyBilling.headers, data: { ...agencyBilling.query, variables: period },
        });
        const body = await response.json();
        expect(body.errors).toBeUndefined();
        const group = body.data.billingSummary.directPartnerGroups.find((g: any) =>
          g.requests.some((r: any) => r.requestNo === requestId));
        expect(group).toMatchObject({ billedToUserId: agencyUser.id, viaAgency: false });
        expect(group.requests.find((r: any) => r.requestNo === requestId)).toMatchObject({ amount: '900000.00', currency: 'KRW' });
        await partnerPage.getByRole('combobox', { name: 'Year', exact: true }).selectOption(String(period.year));
        await partnerPage.getByRole('combobox', { name: 'Month', exact: true }).selectOption(String(period.month));
        await expect(partnerPage.getByRole('link', { name: requestId, exact: true })).toBeVisible();
        await expect(partnerPage.locator('main')).toContainText('KRW 900,000.00');
        const result = { requestId, requestStatus: 'COMPLETED', payerId: agencyUser.id,
          payer: issued.group.billedToName, directBilling: true, amount: '900000.00', currency: 'KRW' };
        await test.info().attach('agency-own-flow-bill-result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
        await test.info().attach('agency-own-bill', { body: await partnerPage.screenshot({ fullPage: true }), contentType: 'image/png' });
        console.log(JSON.stringify(result));
      });
'''
marker = "      console.log(JSON.stringify({ requestId, shipmentStatus: 'COMPLETED', requestStatus: 'COMPLETED', result: 'PASSED' }));"
assert marker in source
source = source.replace(marker, bill + marker)
insert = source.index('function status(')
source = source[:insert] + login + '\n' + create + source[insert:]
(root / 'tests/partner/agency/TC-AG-009-own-request-full-flow-and-bill.spec.ts').write_text(source, encoding='utf-8')
print('Created TC-AG-009 with Agency submission, existing Counselor/Manager workflow, and direct billing verification.')
