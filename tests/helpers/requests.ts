import { expect, Page } from '@playwright/test';

// Valid ZIP containing README.txt: synthetic UAT data, no clinical images.
// Embed the small archive so local runs and CI do not need a binary fixture file.
const reworkCtPlaceholder = Buffer.from(
  'UEsDBBQAAAAIAAAAIVzR8PsCcwAAAJMAAAAKAAAAUkVBRE1FLnR4dE3MMQ6DMAxG4av8FwChjt2qTF1YSA9gBRcsOU6amIHb06nq/PS95TTf2SUhhiEswzTd8HpEVKXEe9GV24i5oJILm2MlJ5SGpGKSSCGZNu4jnubfLsVI9YRYKrkqO9/R+HNwd2TpXWxDiD80F8f7/3Z0Hi9QSwECFAAUAAAACAAAACFc0fD7AnMAAACTAAAACgAAAAAAAAAAAAAAAAAAAAAAUkVBRE1FLnR4dFBLBQYAAAAAAQABADgAAACbAAAAAAA=',
  'base64',
);

// Creates an independent hospital request. The default CT is an incomplete ZIP
// for rework tests; callers may supply a readable synthetic CT fixture instead.
export async function prepareHospitalReworkRequest(page: Page, patientCode: string, ctFile: { name: string; mimeType: string; buffer: Buffer } | null = {
  name: 'rework-ct-placeholder.zip',
  mimeType: 'application/zip',
  buffer: reworkCtPlaceholder,
}, financialAgencyId?: string, material = 'Titanium') {
  await page.goto('/partner/new');
  if (financialAgencyId) {
    await page.getByRole('combobox', { name: /^Financial agency\*/ }).selectOption(financialAgencyId);
  }
  const product = page.getByRole('combobox', { name: 'Product target*', exact: true });
  await expect(product.locator('option')).not.toHaveCount(1);
  await page.getByRole('textbox', { name: 'Requesting surgeon*', exact: true }).fill('Dr. UAT Test');
  await page.getByRole('textbox', { name: 'Requester / coordinator*', exact: true }).fill('UAT Coordinator');
  await product.selectOption({ label: 'Cranium' });
  await page.getByRole('combobox', { name: /^Material\*/ }).selectOption({ label: material });
  await page.getByRole('combobox', { name: /^Detail type\*/ }).selectOption({ label: `Cranium - ${material}` });
  const sizeBucket = page.getByRole('combobox', { name: /^Size bucket\*/ });
  const smallOption = sizeBucket.getByRole('option', { name: /^Small\b/ });
  await expect(smallOption).toHaveCount(1);
  await sizeBucket.selectOption((await smallOption.getAttribute('value'))!);
  await page.getByRole('textbox', { name: 'Patient code*', exact: true }).fill(patientCode);
  const surgeryDate = new Date();
  surgeryDate.setDate(surgeryDate.getDate() + 30);
  await page.getByRole('textbox', { name: 'Planned surgery date*', exact: true })
    .fill(surgeryDate.toISOString().slice(0, 10));
  await page.getByRole('combobox', { name: /^Surgery type\*/ }).selectOption({ label: 'Cranioplasty' });
  if (material === 'Titanium') {
    await page.getByRole('combobox', { name: /^Fixation holes \/ mounting\*/ })
      .selectOption({ label: 'None' });
  }
  await page.getByRole('textbox', { name: 'Case description', exact: true })
    .fill(`${patientCode}: Synthetic UAT workflow test. No patient data; not for clinical use.`);
  await page.getByRole('textbox', { name: 'Delivery recipient*', exact: true }).fill('UAT Recipient');
  await page.getByRole('textbox', { name: 'Ship to*', exact: true }).fill('UAT test address - do not ship');
  if (ctFile) {
    await page.locator('input[type="file"][accept*=".dcm"]').setInputFiles(ctFile);
    await expect(page.getByText(ctFile.name, { exact: true }).first()).toBeVisible();
  }
}

export async function createHospitalReworkRequest(page: Page, patientCode: string, ctFile = {
  name: 'rework-ct-placeholder.zip',
  mimeType: 'application/zip',
  buffer: reworkCtPlaceholder,
}, financialAgencyId?: string, material = 'Titanium') {
  await prepareHospitalReworkRequest(page, patientCode, ctFile, financialAgencyId, material);
  // Both submit controls perform the same action; use the first one consistently.
  await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
  const confirmation = page.getByRole('alertdialog', { name: 'Submit this request?', exact: true });
  await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
  await confirmation.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page).toHaveURL(/\/partner\/requests\/REQ-\d{4}-\d+/);
  const requestId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByRole('heading', { name: requestId, exact: true })).toBeVisible();
  return requestId;
}
