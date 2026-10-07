import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn, signOut, USERS } from '../../helpers/auth';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

test('TC-AG-002: Agency submits its own PBH PEEK Small request at 900000 KRW', async ({ page }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  const user = await signIn(page, USERS.agency);
  expect(user.role).toBe('PARTNER');
  const caseCode = `TC-AG-002-${randomUUID().slice(0, 8)}`;
  await page.goto('/partner/new');
  await page.getByRole('combobox', { name: 'Product target*', exact: true }).selectOption({ label: 'PBH' });
  await page.getByRole('combobox', { name: /^Material\*/ }).selectOption({ label: 'PEEK' });
  await page.getByRole('combobox', { name: /^Detail type\*/ }).selectOption({ label: 'PBH - PEEK' });
  const size = page.getByRole('combobox', { name: /^Size bucket\*/ });
  const small = size.getByRole('option', { name: /^Small\b/ });
  const unavailable = page.getByText('No calculated quote is available. Ask a Manager to configure the applicable price.', { exact: true });
  await expect(async () => {
    expect(await small.count() > 0 || await unavailable.isVisible()).toBe(true);
  }).toPass({ timeout: 15_000 });
  if (await unavailable.isVisible()) {
    const result = { status: 'BLOCKED', account: USERS.agency, product: 'PBH / PEEK / Small',
      expectedPrice: 900000, currency: 'KRW', actual: await unavailable.innerText(),
      availableSizes: await size.locator('option').allTextContents(), requestSubmitted: false };
    await test.info().attach('pricing-blocker', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    await test.info().attach('pricing-unavailable', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    console.log(JSON.stringify(result));
    await signOut(page);
    throw new Error('TC-AG-002 BLOCKED: PBH / PEEK has no calculated quote or Small size; submission and saved payer cannot be verified.');
  }
  await expect(small).toHaveCount(1);
  await size.selectOption((await small.getAttribute('value'))!);
  await expect(page.getByText('Direct billing to this partner account', { exact: true })).toBeVisible();
  await expect(page.getByText(/KRW\s*900,000(?:\.00)?/).first()).toBeVisible();

  await test.step('Complete an Agency-owned request with synthetic case data and CT', async () => {
    await page.getByRole('textbox', { name: 'Requesting surgeon*', exact: true }).fill('Dr. UAT Test');
    await page.getByRole('textbox', { name: 'Hospital*', exact: true }).fill('TC-AG-002 Synthetic Hospital');
    await page.getByRole('textbox', { name: 'Requester / coordinator*', exact: true }).fill('UAT Agency Coordinator');
    await page.getByRole('textbox', { name: 'Patient code*', exact: true }).fill(caseCode);
    const surgeryDate = new Date();
    surgeryDate.setDate(surgeryDate.getDate() + 30);
    await page.getByRole('textbox', { name: 'Planned surgery date*', exact: true }).fill(surgeryDate.toISOString().slice(0, 10));
    await page.getByRole('combobox', { name: /^Surgery type\*/ }).selectOption({ label: 'Cranioplasty' });
    await page.getByRole('combobox', { name: /^Fixation holes \/ mounting\*/ }).selectOption({ label: 'None' });
    await page.getByRole('spinbutton', { name: /^Width/ }).fill('50');
    await page.getByRole('textbox', { name: 'Case description', exact: true }).fill(`${caseCode}: Synthetic UAT Agency own-request test. No patient data; not for clinical use.`);
    await page.getByRole('textbox', { name: 'Delivery recipient*', exact: true }).fill('UAT Recipient');
    await page.getByRole('textbox', { name: 'Ship to*', exact: true }).fill('UAT test address - do not ship');
    const ct = { ...syntheticCtRoundTwo, name: `${caseCode}-synthetic-ct.zip` };
    await page.locator('input[type="file"][accept*=".dcm"]').setInputFiles(ct);
    await expect(page.getByText(ct.name, { exact: true }).first()).toBeVisible();
    await test.info().attach('own-request-before-submit', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  });

  await test.step('Submit and verify persisted price, status and billing', async () => {
    await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
    const confirmation = page.getByRole('alertdialog', { name: 'Submit this request?', exact: true });
    await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
    await confirmation.getByRole('button', { name: 'Submit request', exact: true }).click();
    await expect(page).toHaveURL(/\/partner\/requests\/REQ-\d{4}-\d+/);
    const requestId = new URL(page.url()).pathname.split('/').pop()!;
    test.info().annotations.push({ type: 'request', description: requestId });
    await expect(page.getByRole('heading', { name: requestId, exact: true })).toBeVisible();
    // Leave the page before listening for the persisted request response.
    await page.goto('/account');
    const [body] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql')
        && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
      page.goto(`/partner/requests/${requestId}`),
    ]);
    expect(body.errors).toBeUndefined();
    const details = body.data.request.details;
    await test.info().attach('saved-own-request', { body: JSON.stringify(details, null, 2), contentType: 'application/json' });
    expect(details).toMatchObject({ requestNo: requestId, patientCode: caseCode, status: 'SUBMITTED',
      product: 'PBH', material: 'PEEK', priceSizeBucketLabel: 'Small', priceCurrency: 'KRW' });
    expect(Number(details.priceBaseAmount)).toBe(900000);
    expect(Number(details.quotedPrice)).toBe(900000);
    expect(Number(details.priceAdjustmentPercent ?? 0)).toBe(0);
    expect(Number(details.priceAdjustmentAmount ?? 0)).toBe(0);
    expect(details.financialAgencyUserId).toBeNull();
    await expect(page.getByRole('button', { name: 'Submitted', exact: true })).toBeVisible();
    const billing = page.getByRole('term').filter({ hasText: /^Billing account$/ }).locator('xpath=following-sibling::dd[1]');
    await expect(billing).toContainText(/Direct/i);
    await test.info().attach('submitted-own-request', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  });
  await signOut(page);
});
