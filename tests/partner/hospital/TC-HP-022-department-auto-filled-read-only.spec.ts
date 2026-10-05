import { expect, test } from '@playwright/test';
import { signIn } from '../../helpers/auth';

test('TC-HP-022: Hospital department is populated from its account and cannot be edited', async ({ page }) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, 'hospital.a@saerosoft.com');
  await page.goto('/partner/profile');
  await expect(page.getByRole('heading', { name: 'Profile / Account', exact: true })).toBeVisible();
  const profileDepartment = page.getByRole('combobox', { name: 'Department', exact: true });
  await expect(profileDepartment).not.toHaveValue('');
  const savedDepartment = await profileDepartment.locator('option:checked').innerText();
  await page.goto('/partner/new');
  await expect(page.getByRole('heading', { name: 'New Request', exact: true })).toBeVisible();
  const department = page.getByRole('textbox', { name: /^Department\b/ });
  await expect(department).toHaveValue(savedDepartment);
  await expect(department).toBeDisabled();
  await expect(page.getByRole('combobox', { name: /^Department\b/ })).toHaveCount(0);
  await department.scrollIntoViewIfNeeded();
  await test.info().attach('new-request-department', { body: await page.screenshot(), contentType: 'image/png' });
  const result = { account: 'Hospital A', accountDepartment: savedDepartment,
    requestDepartment: await department.inputValue(), editable: false };
  await test.info().attach('department-verification', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  console.log(JSON.stringify(result));
});
