import { expect, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';

test('TC-MG-018: Partner ETC requirement follows the detail type flag while CT stays required', async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, USERS.manager);
  const flag = page.getByRole('checkbox', { name: 'Require an ETC supporting-file upload for this detail type', exact: true });
  async function openDetail() {
    await page.goto('/manager/reference-data');
    await page.getByRole('button', { name: 'Detail types', exact: true }).click();
    await page.getByRole('button', { name: /^Cranium \/ Cranium \/ PEEK / }).click();
    await expect(page.getByRole('textbox', { name: 'Display name*', exact: true })).toHaveValue('Cranium - PEEK');
    await expect(flag).toBeVisible();
  }
  async function setRequired(required: boolean) {
    await openDetail();
    if (await flag.isChecked() !== required) {
      await flag.setChecked(required);
      const [body] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql')
          && /mutation/.test(r.request().postDataJSON()?.query ?? '')).then(r => r.json()),
        page.getByRole('button', { name: 'Save detail type', exact: true }).click(),
      ]);
      expect(body.errors).toBeUndefined();
    }
    await openDetail();
    await expect(flag).toBeChecked({ checked: required });
  }
  await openDetail();
  const original = await flag.isChecked();
  const context = await browser.newContext({ baseURL });
  context.setDefaultTimeout(15_000);
  const results: object[] = [];
  try {
    const partner = await context.newPage();
    await signIn(partner, USERS.hospital);
    for (const required of [true, false]) {
      await test.step(`ETC ${required ? 'required' : 'optional'} reaches a freshly opened Partner form; CT remains required`, async () => {
        await setRequired(required);
        await partner.goto('/partner/new');
        await partner.getByRole('combobox', { name: 'Product target*', exact: true }).selectOption({ label: 'Cranium' });
        await partner.getByRole('combobox', { name: /^Material\*/ }).selectOption({ label: 'PEEK' });
        await partner.getByRole('combobox', { name: /^Detail type\*/ }).selectOption({ label: 'Cranium - PEEK' });
        const ct = partner.locator('label').filter({ has: partner.getByText('CT file', { exact: true }) });
        const etc = partner.locator('label').filter({ has: partner.getByText('ETC files', { exact: true }) });
        await expect(ct.getByText('REQUIRED', { exact: true })).toBeVisible();
        await expect(etc.getByText(required ? 'REQUIRED' : 'NOT REQUIRED', { exact: true })).toBeVisible();
        await expect(etc.getByText(required ? 'NOT REQUIRED' : 'REQUIRED', { exact: true })).toHaveCount(0);
        await etc.scrollIntoViewIfNeeded();
        await test.info().attach(`etc-${required ? 'required' : 'optional'}`, { body: await partner.screenshot(), contentType: 'image/png' });
        results.push({ configuredEtcRequired: required, ctLabel: await ct.innerText(), etcLabel: await etc.innerText() });
      });
    }
  } finally {
    try {
      await setRequired(original);
      await test.info().attach('file-requirement-results', {
        body: JSON.stringify({ detailType: 'Cranium - PEEK', originalEtcRequired: original, restored: true, results }, null, 2), contentType: 'application/json',
      });
      console.log(JSON.stringify({ originalEtcRequired: original, restored: true, results }));
    } finally { await context.close(); }
  }
});
