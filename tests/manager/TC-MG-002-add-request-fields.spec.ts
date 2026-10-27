import { expect, test } from '@playwright/test';
import { signIn, clearSession, USERS } from '../helpers/auth';
import { prepareHospitalReworkRequest } from '../helpers/requests';

// TC-MG-002 now covers the current partner request form. Legacy surgery-type,
// fixation-hole and width-limit requirements were retired from this test.
test('TC-MG-002: Current required request fields validate before submission', async ({ page }) => {
  await signIn(page, USERS.hospital);
  const patientName = 'TC-MG-002 synthetic validation';
  await prepareHospitalReworkRequest(page, patientName, undefined, undefined, 'PEEK');

  for (const name of [
    'Responsible doctor*',
    'Requester / coordinator*',
    'Planned surgery date*',
    'Delivery recipient*',
    'Ship to*',
  ]) {
    await expect(page.getByRole('textbox', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name, exact: true })).toBeEditable();
  }
  await expect(page.getByRole('button', { name: 'Product', exact: true })).toHaveText(
    'PEEK · Cranial',
  );
  const patient = page.getByRole('textbox', { name: /^Patient name\*/ });
  await expect(patient).toHaveValue(patientName);
  await patient.fill('');
  await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
  await expect(page.getByText('Patient name is required.', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/partner\/new$/);
  const confirmation = page.getByRole('alertdialog', { name: 'Submit this request?', exact: true });
  await expect(confirmation).toBeHidden();

  await patient.fill(patientName);
  await page.getByRole('button', { name: 'Submit request', exact: true }).first().click();
  await expect(confirmation).toBeVisible();
  const submit = confirmation.getByRole('button', { name: 'Submit request', exact: true });
  await expect(submit).toBeDisabled();
  await confirmation
    .getByRole('checkbox', { name: /^I reviewed the case details and files/ })
    .check();
  await expect(submit).toBeEnabled();
  // Stop at confirmation: this validation test does not create a request.
  await confirmation.getByRole('button', { name: 'Continue editing', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await clearSession(page);
});
