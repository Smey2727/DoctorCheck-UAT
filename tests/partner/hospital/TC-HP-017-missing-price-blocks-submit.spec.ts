import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { waitForGraphqlResponse } from '../../helpers/graphql';
import { signIn, USERS } from '../../helpers/auth';
import { prepareHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

async function pricingRow(page: Page) {
  await page.goto('/manager/pricing');
  await expect(page.getByRole('heading', { name: 'Cranial / PEEK', exact: true })).toBeVisible();
  const showArchived = page.getByRole('button', { name: 'Show archived', exact: true });
  if (await showArchived.isVisible()) {
    await showArchived.click();
  }
  return page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'Small', exact: true }) });
}

async function togglePrice(page: Page, action: 'Archive' | 'Restore') {
  await (await pricingRow(page)).getByRole('button', { name: action, exact: true }).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toBeVisible();
  const [body] = await Promise.all([
    page
      .waitForResponse(
        (r) =>
          r.url().endsWith('/graphql') && /mutation/.test(r.request().postDataJSON()?.query ?? ''),
      )
      .then((response) => response.json()),
    confirmation.getByRole('button', { name: new RegExp(action, 'i') }).click(),
  ]);
  expect(body.errors).toBeUndefined();
  await expect(confirmation).toBeHidden();
  await expect(
    (await pricingRow(page)).getByRole('button', {
      name: action === 'Archive' ? 'Restore' : 'Archive',
      exact: true,
    }),
  ).toBeVisible();
}

test('TC-HP-017: Archiving a displayed size price rejects stale submission; restoring pricing allows submission', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const managerContext = await browser.newContext({ baseURL });
  managerContext.setDefaultTimeout(15_000);
  const manager = await managerContext.newPage();
  try {
    await signIn(manager, USERS.manager);
    const row = await pricingRow(manager);
    await expect(row.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
    const original = await row
      .getByRole('textbox', { name: 'New price', exact: true })
      .inputValue();
    expect(Number(original)).toBeGreaterThan(0);
    await signIn(page, 'hospital.c@saerosoft.com');
    const code = `TC-HP-017-${randomUUID().slice(0, 8)}`;
    const ct = { ...syntheticCtRoundTwo, name: `${code}-ct.zip` };
    await prepareHospitalReworkRequest(page, code, ct, undefined, 'PEEK');
    let restorationNeeded = true;
    try {
      await test.step('Manager archives the Small size price from the displayed price table', async () => {
        await togglePrice(manager, 'Archive');
      });
      await test.step('Submission using the old price table is rejected after Small pricing is archived', async () => {
        await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
        const confirmation = page.getByRole('alertdialog', {
          name: 'Submit this request?',
          exact: true,
        });
        await confirmation
          .getByRole('checkbox', { name: /^I reviewed the case details and files/ })
          .check();
        const [body] = await Promise.all([
          page
            .waitForResponse(
              (r) =>
                r.url().endsWith('/graphql') &&
                /mutation/.test(r.request().postDataJSON()?.query ?? ''),
            )
            .then((response) => response.json()),
          confirmation.getByRole('button', { name: 'Submit request', exact: true }).click(),
        ]);
        console.log('BLOCKED_SUBMISSION', JSON.stringify(body));
        expect(body.errors?.length).toBeGreaterThan(0);
        expect(body.errors[0].message).toMatch(/price|pricing|quote|size bucket/i);
        expect(body.errors[0].extensions.code).toBe('pricing.priceTable.changed');
        expect(body.data).toBeNull();
        await expect(confirmation).toBeHidden();
        await expect(page.getByRole('alert')).toHaveText(
          'Prices changed. Check the new prices and confirm again.',
        );
        await expect(page).toHaveURL(/\/partner\/new$/);
        await test.info().attach('missing-price-blocks-submission', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
        await test.info().attach('price-validation-response', {
          body: JSON.stringify(body, null, 2),
          contentType: 'application/json',
        });

        await expect(page.getByRole('textbox', { name: /^Patient name\*/ })).toHaveValue(code);
      });
      await test.step('Manager restores a positive price and verifies it persisted', async () => {
        await togglePrice(manager, 'Restore');
        await expect(
          (await pricingRow(manager)).getByRole('textbox', { name: 'New price', exact: true }),
        ).toHaveValue(original);
        restorationNeeded = false;
      });
      await test.step('Submit succeeds after the positive price is available', async () => {
        // Reopen the new form to obtain a fresh server quote after restoration.
        await prepareHospitalReworkRequest(page, code, ct, undefined, 'PEEK');
        await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
        const confirmation = page.getByRole('alertdialog', {
          name: 'Submit this request?',
          exact: true,
        });
        await confirmation
          .getByRole('checkbox', { name: /^I reviewed the case details and files/ })
          .check();
        const [body] = await Promise.all([
          page
            .waitForResponse(
              (r) =>
                r.url().endsWith('/graphql') &&
                /mutation/.test(r.request().postDataJSON()?.query ?? ''),
            )
            .then((response) => response.json()),
          confirmation.getByRole('button', { name: 'Submit request', exact: true }).click(),
        ]);
        expect(body.errors).toBeUndefined();
        await expect(page).toHaveURL(/\/partner\/requests\/REQ-\d{4}-\d+/);
        const requestId = new URL(page.url()).pathname.split('/').pop()!;
        await expect(page.getByRole('heading', { name: requestId, exact: true })).toBeVisible();
        const [persisted] = await Promise.all([
          waitForGraphqlResponse(page, 'Request').then((response) => response.json()),
          page.reload(),
        ]);
        expect(persisted.errors).toBeUndefined();
        expect(persisted.data.request.details).toMatchObject({
          status: 'SUBMITTED',
          patientName: code,
        });
        const lines = persisted.data.request.details.lines;
        expect(lines).toHaveLength(1);
        const small = lines[0].priceTable.options.find(
          (option: any) => option.sizeBucketLabel === 'Small',
        );
        expect(small).toBeDefined();
        expect(Number(small.calculatedAmount)).toBe(Number(original));
        test.info().annotations.push({ type: 'request', description: requestId });
        await test.info().attach('positive-price-submission-success', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
        console.log(
          JSON.stringify({
            requestId,
            missingActivePriceBlocked: true,
            restoredPrice: original,
            finalStatus: 'SUBMITTED',
          }),
        );
      });
    } finally {
      test.setTimeout(test.info().timeout + 30_000);
      if (restorationNeeded) {
        const current = await pricingRow(manager);
        if (await current.getByRole('button', { name: 'Restore', exact: true }).isVisible()) {
          await togglePrice(manager, 'Restore');
        }
        await expect(
          (await pricingRow(manager)).getByRole('textbox', { name: 'New price', exact: true }),
        ).toHaveValue(original);
        await expect(
          (await pricingRow(manager)).getByRole('button', { name: 'Archive', exact: true }),
        ).toBeVisible();
      }
    }
  } finally {
    await managerContext.close();
  }
});
