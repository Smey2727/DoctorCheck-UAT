import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { waitForGraphqlResponse } from '../../helpers/graphql';
import { signInFresh as signIn, signOut, USERS } from '../../helpers/auth';
import {
  ensureAgencyCranialPeekPricing,
  prepareHospitalReworkRequest,
} from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

function fieldName(label: string) {
  // Inline validation text may be appended to the accessible field name.
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$| )`);
}

test('TC-HP-014: Draft fields and CT file survive logout and login until submission', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const managerContext = await browser.newContext({ baseURL });
  const manager = await managerContext.newPage();
  let cleanupPricing: (() => Promise<void>) | undefined;
  try {
    await signIn(manager, USERS.manager);
    cleanupPricing = await ensureAgencyCranialPeekPricing(manager);
    await signIn(page, 'hospital.a@saerosoft.com');
    const code = `TC-HP-014-${randomUUID().slice(0, 8)}`;
    const ct = { ...syntheticCtRoundTwo, name: `${code}-ct.zip` };
    await prepareHospitalReworkRequest(page, code, ct, undefined, 'PEEK');
    await page
      .getByRole('textbox', { name: 'Responsible doctor*', exact: true })
      .fill('Dr. ' + code);
    const surgeryDate = page.getByRole('textbox', { name: /^Planned surgery date\*/ });
    const plannedDate = await surgeryDate.inputValue();
    await surgeryDate.fill('');
    await page
      .getByRole('textbox', { name: 'Delivery notes', exact: true })
      .fill(`${code}: Synthetic receiving instructions.`);
    const textFields = [
      'Responsible doctor*',
      'Requester / coordinator*',
      'Case contact',
      'Patient name*',
      'Planned surgery date*',
      'Case description',
      'Delivery recipient*',
      'Recipient contact',
      'Ship to*',
      'Delivery notes',
    ];
    const product = page.getByRole('button', { name: 'Product', exact: true });
    const selectedProduct = await product.innerText();
    const assignedAgency = page.getByRole('textbox', { name: /^Financial agency/ });
    const agencyName = await assignedAgency.inputValue();
    const textValues = await Promise.all(
      textFields.map((name) => page.getByRole('textbox', { name: fieldName(name) }).inputValue()),
    );
    const [saved] = await Promise.all([
      waitForGraphqlResponse(page, 'SaveRequestDraft').then((response) => response.json()),
      page
        .getByRole('button', { name: /^Save draft$/i })
        .first()
        .click(),
    ]);
    expect(saved.errors).toBeUndefined();
    expect(saved.data.saveRequestDraft.status).toBe('DRAFT');
    await expect(page).toHaveURL(/\/partner\/requests$/);
    await page.getByRole('link', { name: /^Drafts/ }).click();
    await page.getByPlaceholder('Search patient, Hospital, doctor, or request no.').fill(code);
    const requestId = saved.data.saveRequestDraft.requestNo;
    const resumeLink = page.locator('a[href="/partner/requests/' + requestId + '/edit"]');
    const draftRow = page.getByRole('listitem').filter({ has: resumeLink });
    await expect(draftRow).toHaveCount(1);
    test.info().annotations.push({ type: 'request', description: requestId });
    await expect(draftRow.getByRole('button', { name: 'Draft', exact: true })).toBeVisible();
    const [beforeBody] = await Promise.all([
      waitForGraphqlResponse(page, 'Request').then((response) => response.json()),
      resumeLink.click(),
    ]);
    expect(beforeBody.errors).toBeUndefined();
    const before = beforeBody.data.request.details;
    expect(before.status).toBe('DRAFT');
    expect(before.submittedAt).toBeNull();
    const originalCt = before.attachments.filter((a: any) => a.category === 'CT');
    expect(originalCt).toHaveLength(1);
    expect(originalCt[0].file).toMatchObject({ originalName: ct.name, status: 'AVAILABLE' });
    await signOut(page);
    await signIn(page, 'hospital.a@saerosoft.com');
    await page.goto('/partner/requests');
    await page.getByRole('link', { name: /^Drafts/ }).click();
    await page.getByPlaceholder('Search patient, Hospital, doctor, or request no.').fill(code);
    await expect(draftRow.getByRole('button', { name: 'Draft', exact: true })).toBeVisible();
    const [resumedBody] = await Promise.all([
      waitForGraphqlResponse(page, 'Request').then((response) => response.json()),
      resumeLink.click(),
    ]);
    expect(resumedBody.errors).toBeUndefined();
    const resumed = resumedBody.data.request.details;
    expect(resumed.status).toBe('DRAFT');
    expect(resumed.submittedAt).toBeNull();
    expect(
      resumed.attachments
        .filter((a: any) => a.category === 'CT')
        .map((a: any) => ({ id: a.id, fileId: a.file.id })),
    ).toEqual(originalCt.map((a: any) => ({ id: a.id, fileId: a.file.id })));
    await expect(page.getByRole('textbox', { name: /^Patient name\*/ })).toHaveValue(code);
    await test.step('Entered fields and original attached CT survive the new login', async () => {
      await expect(page.getByRole('heading', { name: 'Resume Draft', exact: true })).toBeVisible();
      for (let i = 0; i < textFields.length; i++) {
        await expect(page.getByRole('textbox', { name: fieldName(textFields[i]) })).toHaveValue(
          textValues[i],
        );
      }
      await expect(product).toHaveText(selectedProduct);
      await expect(assignedAgency).toHaveValue(agencyName);
      await expect(assignedAgency).toBeDisabled();
      await expect(page.getByText(ct.name, { exact: true }).first()).toBeVisible();
      await test.info().attach('resumed-draft-with-fields-and-file', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    });
    await test.step('Completing the missing surgery date and submitting moves the same draft to SUBMITTED', async () => {
      await surgeryDate.fill(plannedDate);
      await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
      const confirmation = page.getByRole('alertdialog', {
        name: 'Submit this request?',
        exact: true,
      });
      await confirmation
        .getByRole('checkbox', { name: /^I reviewed the case details and files/ })
        .check();
      const [submittedBody] = await Promise.all([
        page
          .waitForResponse(
            (r) =>
              r.url().endsWith('/graphql') &&
              /mutation/.test(r.request().postDataJSON()?.query ?? ''),
          )
          .then((response) => response.json()),
        confirmation.getByRole('button', { name: 'Submit request', exact: true }).click(),
      ]);
      expect(submittedBody.errors).toBeUndefined();
      await expect(page).toHaveURL(new RegExp(`/partner/requests/${requestId}$`));
      await expect(
        page
          .getByRole('heading', { name: requestId, exact: true })
          .locator('..')
          .getByRole('button', { name: 'Submitted', exact: true }),
      ).toBeVisible();
      const [persistedBody] = await Promise.all([
        waitForGraphqlResponse(page, 'Request').then((response) => response.json()),
        page.reload(),
      ]);
      expect(persistedBody.errors).toBeUndefined();
      const submitted = persistedBody.data.request.details;
      expect(submitted.status).toBe('SUBMITTED');
      expect(submitted.submittedAt).toBeTruthy();
      expect(submitted.attachments.find((a: any) => a.category === 'CT').file.id).toBe(
        originalCt[0].file.id,
      );
      await test
        .info()
        .attach('draft-submitted', { body: await page.screenshot(), contentType: 'image/png' });
      const result = {
        requestId,
        statusAfterNewLogin: 'DRAFT',
        enteredFieldsPreserved: textFields.length + 2,
        originalCtPreserved: true,
        finalStatus: 'SUBMITTED',
      };
      await test.info().attach('draft-results', {
        body: JSON.stringify(result, null, 2),
        contentType: 'application/json',
      });
      console.log(JSON.stringify(result));
    });
  } finally {
    test.setTimeout(test.info().timeout + 30_000);
    try {
      await cleanupPricing?.();
    } finally {
      await managerContext.close();
    }
  }
});
