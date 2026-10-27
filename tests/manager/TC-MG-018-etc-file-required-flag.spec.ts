import { expect, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';
import { prepareHospitalReworkRequest } from '../helpers/requests';
import { syntheticCtRoundTwo } from '../helpers/synthetic-ct';

test('TC-MG-018: Partner ETC requirement follows the detail type flag while CT stays required', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, USERS.manager);
  const flag = page.getByRole('checkbox', {
    name: 'Require an ETC supporting-file upload for this detail type',
    exact: true,
  });
  async function openDetail() {
    await page.goto('/manager/reference-data');
    await page.getByRole('button', { name: 'Detail types', exact: true }).click();
    await page.getByRole('button', { name: 'Cranial / Cranial / PEEK', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Display name*', exact: true })).toHaveValue(
      'Cranium - PEEK',
    );
    await expect(flag).toBeVisible();
  }
  async function setRequired(required: boolean) {
    await openDetail();
    if ((await flag.isChecked()) !== required) {
      await flag.setChecked(required);
      const [body] = await Promise.all([
        page
          .waitForResponse(
            (r) =>
              r.url().endsWith('/graphql') &&
              /mutation/.test(r.request().postDataJSON()?.query ?? ''),
          )
          .then((response) => response.json()),
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
        await prepareHospitalReworkRequest(
          partner,
          'TC-MG-018 synthetic validation',
          null,
          undefined,
          'PEEK',
        );
        const ct = partner.getByRole('group', { name: 'CT file', exact: true });
        const etc = partner.getByRole('group', { name: 'ETC files', exact: true });
        const submit = partner.getByRole('button', { name: 'Submit request', exact: true }).first();
        await submit.click();
        await expect(ct).toHaveAttribute('aria-invalid', 'true');
        await expect(partner.getByRole('alertdialog')).toHaveCount(0);
        await partner
          .locator('input[type="file"][accept*=".dcm"]')
          .setInputFiles(syntheticCtRoundTwo);
        await submit.click();
        const confirmation = partner.getByRole('alertdialog', {
          name: 'Submit this request?',
          exact: true,
        });
        if (required) {
          await expect(confirmation).toHaveCount(0);
          await expect(etc).toHaveAttribute('aria-invalid', 'true');
          await etc.locator('input[type="file"]').setInputFiles({
            name: 'TC-MG-018-support.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('Synthetic UAT supporting file; no patient data.'),
          });
          await submit.click();
        }
        await expect(confirmation).toBeVisible();
        await confirmation.getByRole('button', { name: 'Continue editing', exact: true }).click();
        await etc.scrollIntoViewIfNeeded();
        await test.info().attach(`etc-${required ? 'required' : 'optional'}`, {
          body: await partner.screenshot(),
          contentType: 'image/png',
        });
        results.push({
          configuredEtcRequired: required,
          ctLabel: await ct.innerText(),
          etcLabel: await etc.innerText(),
        });
      });
    }
  } finally {
    test.setTimeout(test.info().timeout + 30_000);
    try {
      await setRequired(original);
      await test.info().attach('file-requirement-results', {
        body: JSON.stringify(
          { detailType: 'Cranium - PEEK', originalEtcRequired: original, restored: true, results },
          null,
          2,
        ),
        contentType: 'application/json',
      });
      console.log(JSON.stringify({ originalEtcRequired: original, restored: true, results }));
    } finally {
      await context.close();
    }
  }
});
