import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signIn, signOut } from '../../helpers/auth';
import { prepareHospitalReworkRequest } from '../../helpers/requests';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

function fieldName(label: string) {
  // Inline validation text may be appended to the accessible field name.
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$| )`);
}

test('TC-HP-014: Draft fields and CT file survive logout and login until submission', async ({ page }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, 'hospital.a@saerosoft.com');
  const code = `TC-HP-014-${randomUUID().slice(0, 8)}`;
  const ct = { ...syntheticCtRoundTwo, name: `${code}-ct.zip` };
  await prepareHospitalReworkRequest(page, code, ct, undefined, 'PEEK');
  await page.getByRole('textbox', { name: 'Requesting surgeon*', exact: true }).fill('');
  await page.getByRole('combobox', { name: /^Surgery type\*/ }).selectOption('');
  await page.getByRole('textbox', { name: 'Delivery notes', exact: true }).fill(`${code}: Synthetic receiving instructions.`);
  const textFields = ['Requesting surgeon*', 'Requester / coordinator*', 'Case contact', 'Patient code*',
    'Planned surgery date*', 'Case description', 'Delivery recipient*', 'Recipient contact', 'Ship to*', 'Delivery notes'];
  const selections = [/^Product target\*/, /^Material\*/, /^Detail type\*/, /^Financial agency\*/, /^Size bucket\*/, /^Surgery type\*/];
  const textValues = await Promise.all(textFields.map(name => page.getByRole('textbox', { name: fieldName(name) }).inputValue()));
  const selectedValues = await Promise.all(selections.map(name => page.getByRole('combobox', { name }).inputValue()));
  const [saved] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && /mutation/.test(r.request().postDataJSON()?.query ?? '')).then(r => r.json()),
    page.getByRole('button', { name: /^Save draft$/i }).first().click(),
  ]);
  expect(saved.errors).toBeUndefined();
  expect(saved.data.saveRequestDraft.status).toBe('DRAFT');
  await expect(page).toHaveURL(/\/partner\/requests$/);
  await page.getByRole('button', { name: /^Drafts(?:,|$)/ }).click();
  await page.getByPlaceholder('Search request no - patient - product').fill(code);
  const draftRow = page.getByRole('row').filter({ hasText: code });
  await expect(draftRow).toHaveCount(1);
  const requestId = (await draftRow.getByRole('cell').first().innerText()).trim();
  expect(requestId).toBe(saved.data.saveRequestDraft.requestNo);
  test.info().annotations.push({ type: 'request', description: requestId });
  await expect(draftRow.getByRole('button', { name: 'Draft', exact: true })).toBeVisible();
  const [beforeBody] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    draftRow.getByRole('link', { name: 'Resume', exact: true }).click(),
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
  await page.getByRole('button', { name: /^Drafts(?:,|$)/ }).click();
  await page.getByPlaceholder('Search request no - patient - product').fill(code);
  await expect(draftRow.getByRole('button', { name: 'Draft', exact: true })).toBeVisible();
  const [resumedBody] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    draftRow.getByRole('link', { name: 'Resume', exact: true }).click(),
  ]);
  expect(resumedBody.errors).toBeUndefined();
  const resumed = resumedBody.data.request.details;
  expect(resumed.status).toBe('DRAFT');
  expect(resumed.submittedAt).toBeNull();
  expect(resumed.attachments.filter((a: any) => a.category === 'CT').map((a: any) => ({ id: a.id, fileId: a.file.id })))
    .toEqual(originalCt.map((a: any) => ({ id: a.id, fileId: a.file.id })));
  await expect(page.getByRole('textbox', { name: 'Patient code*', exact: true })).toHaveValue(code);
  await test.step('Entered fields and original attached CT survive the new login', async () => {
    await expect(page.getByRole('heading', { name: 'Resume Draft', exact: true })).toBeVisible();
    for (let i = 0; i < textFields.length; i++) {
      await expect(page.getByRole('textbox', { name: fieldName(textFields[i]) })).toHaveValue(textValues[i]);
    }
    for (let i = 0; i < selections.length; i++) {
      await expect(page.getByRole('combobox', { name: selections[i] })).toHaveValue(selectedValues[i]);
    }
    await expect(page.getByText(ct.name, { exact: true }).first()).toBeVisible();
    await test.info().attach('resumed-draft-with-fields-and-file', { body: await page.screenshot(), contentType: 'image/png' });
  });
  await test.step('Completing the missing fields and submitting moves the same draft to SUBMITTED', async () => {
    await page.getByRole('textbox', { name: 'Requesting surgeon*', exact: true }).fill('Dr. UAT Test');
    await page.getByRole('combobox', { name: /^Surgery type\*/ }).selectOption({ label: 'Cranioplasty' });
    await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
    const confirmation = page.getByRole('alertdialog', { name: 'Submit this request?', exact: true });
    await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
    const [submittedBody] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql')
        && /mutation/.test(r.request().postDataJSON()?.query ?? '')).then(r => r.json()),
      confirmation.getByRole('button', { name: 'Submit request', exact: true }).click(),
    ]);
    expect(submittedBody.errors).toBeUndefined();
    await expect(page).toHaveURL(new RegExp(`/partner/requests/${requestId}$`));
    await expect(page.getByRole('heading', { name: requestId, exact: true }).locator('..')
      .getByRole('button', { name: 'Submitted', exact: true })).toBeVisible();
    const [persistedBody] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql')
        && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
      page.reload(),
    ]);
    expect(persistedBody.errors).toBeUndefined();
    const submitted = persistedBody.data.request.details;
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.submittedAt).toBeTruthy();
    expect(submitted.attachments.find((a: any) => a.category === 'CT').file.id).toBe(originalCt[0].file.id);
    await test.info().attach('draft-submitted', { body: await page.screenshot(), contentType: 'image/png' });
    const result = { requestId, statusAfterNewLogin: 'DRAFT', enteredFieldsPreserved: textFields.length + selections.length,
      originalCtPreserved: true, finalStatus: 'SUBMITTED' };
    await test.info().attach('draft-results', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify(result));
  });
});
