import { expect, test } from '@playwright/test';
import { waitForUpload } from './helpers/uploads';
import { waitForGraphqlResponse } from './helpers/graphql';

test('Upload cooldown permits automatic completion without resubmitting', async ({ page }) => {
  test.setTimeout(2000);
  await page.setContent(
    '<p>Upload limit reached. Try again in 1 sec</p><button disabled>Submit</button><script>setTimeout(() => document.querySelector("button").disabled = false, 2500)</script>',
  );
  const submit = page.getByRole('button', { name: 'Submit', exact: true });
  await waitForUpload(page, () => submit.isEnabled());
  await expect(submit).toBeEnabled();
  expect(test.info().annotations.some((annotation) => annotation.type === 'upload-cooldown')).toBe(
    true,
  );
});

test('Design registration wait preserves server errors for the caller to assert', async ({
  page,
}) => {
  await page.route('**/*', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ errors: [{ message: 'Registration rejected' }] }),
      });
    } else {
      await route.fulfill({
        contentType: 'text/html',
        body: "<button onclick=\"fetch('/graphql', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({operationName: 'RegisterDesignFile'})})\">Register</button>",
      });
    }
  });
  await page.goto('/');
  const response = waitForGraphqlResponse(page, 'RegisterDesignFile');
  await page.getByRole('button', { name: 'Register' }).click();
  expect((await (await response).json()).errors).toEqual([{ message: 'Registration rejected' }]);
});
