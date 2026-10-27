import { expect, Page } from '@playwright/test';
import { waitForGraphqlResponse } from './graphql';
import { waitForUpload } from './uploads';

// Valid ZIP containing README.txt: synthetic UAT data, no clinical images.
// Embed the small archive so local runs and CI do not need a binary fixture file.
const reworkCtPlaceholder = Buffer.from(
  'UEsDBBQAAAAIAAAAIVzR8PsCcwAAAJMAAAAKAAAAUkVBRE1FLnR4dE3MMQ6DMAxG4av8FwChjt2qTF1YSA9gBRcsOU6amIHb06nq/PS95TTf2SUhhiEswzTd8HpEVKXEe9GV24i5oJILm2MlJ5SGpGKSSCGZNu4jnubfLsVI9YRYKrkqO9/R+HNwd2TpXWxDiD80F8f7/3Z0Hi9QSwECFAAUAAAACAAAACFc0fD7AnMAAACTAAAACgAAAAAAAAAAAAAAAAAAAAAAUkVBRE1FLnR4dFBLBQYAAAAAAQABADgAAACbAAAAAAA=',
  'base64',
);

interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const defaultCtFile: UploadFile = {
  name: 'rework-ct-placeholder.zip',
  mimeType: 'application/zip',
  buffer: reworkCtPlaceholder,
};

// Creates an independent hospital request. The default CT is an incomplete ZIP
// for rework tests; callers may supply a readable synthetic CT fixture instead.
export async function prepareHospitalReworkRequest(
  page: Page,
  patientName: string,
  ctFile: UploadFile | null = defaultCtFile,
  financialAgencyId?: string,
  material = 'Titanium',
) {
  if (financialAgencyId) {
    const [body] = await Promise.all([
      waitForGraphqlResponse(page, 'FinancialAgency').then((response) => response.json()),
      page.goto('/partner/new'),
    ]);
    expect(body.errors).toBeUndefined();
    expect(body.data.financialAgency.id).toBe(financialAgencyId);
    const agency = page.getByRole('textbox', { name: /^Financial agency/ });
    await expect(agency).toHaveValue(body.data.financialAgency.organizationName);
    await expect(agency).toBeDisabled();
  } else {
    await page.goto('/partner/new');
  }
  await page
    .getByRole('textbox', { name: 'Responsible doctor*', exact: true })
    .fill('Dr. UAT Test');
  await page
    .getByRole('textbox', { name: 'Requester / coordinator*', exact: true })
    .fill('UAT Coordinator');
  // The product picker groups complete configurations by material and category.
  // The counselor selects the final size during design.
  const product = page.getByRole('button', { name: 'Product', exact: true });
  await expect(product).toBeVisible();
  if ((await product.getAttribute('aria-expanded')) !== 'true') await product.click();
  await page.getByRole('button', { name: `Cranial Cranium - ${material}`, exact: true }).click();
  await page.getByRole('textbox', { name: /^Patient name\*/ }).fill(patientName);
  const surgeryDate = new Date();
  surgeryDate.setDate(surgeryDate.getDate() + 30);
  await page
    .getByRole('textbox', { name: 'Planned surgery date*', exact: true })
    .fill(surgeryDate.toISOString().slice(0, 10));
  // These extra fields depend on the manager-configured product catalog.
  const surgeryType = page.getByRole('combobox', { name: /^Surgery type\*/ });
  if (await surgeryType.count()) {
    await surgeryType.selectOption({ label: 'Cranioplasty' });
  }
  const fixationHoles = page.getByRole('combobox', { name: /^Fixation holes \/ mounting\*/ });
  if (material === 'Titanium' && (await fixationHoles.count())) {
    await fixationHoles.selectOption({ label: 'None' });
  }
  await page
    .getByRole('textbox', { name: 'Case description', exact: true })
    .fill(`${patientName}: Synthetic UAT workflow test. No patient data; not for clinical use.`);
  await page
    .getByRole('textbox', { name: 'Delivery recipient*', exact: true })
    .fill('UAT Recipient');
  await page
    .getByRole('textbox', { name: 'Ship to*', exact: true })
    .fill('UAT test address - do not ship');
  if (ctFile) {
    await page.locator('input[type="file"][accept*=".dcm"]').setInputFiles(ctFile);
    await expect(page.getByText(ctFile.name, { exact: true }).first()).toBeVisible();
    await waitForUpload(page, () =>
      page
        .getByRole('group', { name: 'CT file', exact: true })
        .getByText(`Uploaded: ${ctFile.name}`, { exact: true })
        .isVisible(),
    );
  }
}

export async function createHospitalReworkRequest(
  page: Page,
  patientName: string,
  ctFile: UploadFile = defaultCtFile,
  financialAgencyId?: string,
  material = 'Titanium',
) {
  await prepareHospitalReworkRequest(page, patientName, ctFile, financialAgencyId, material);
  // Both submit controls perform the same action; use the first one consistently.
  await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
  const confirmation = page.getByRole('alertdialog', { name: 'Submit this request?', exact: true });
  await confirmation
    .getByRole('checkbox', { name: /^I reviewed the case details and files/ })
    .check();
  await confirmation.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page).toHaveURL(/\/partner\/requests\/REQ-\d{4}-\d+/);
  const requestId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByRole('heading', { name: requestId, exact: true })).toBeVisible();
  return requestId;
}
