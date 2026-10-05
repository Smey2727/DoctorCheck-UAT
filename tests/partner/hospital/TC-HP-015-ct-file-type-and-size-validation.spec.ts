import { BrowserContext, expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';
import { syntheticCtRoundTwo } from '../../helpers/synthetic-ct';

// The user clarified that this case checks the default file-picker filter.
// Headless Playwright verifies chooser configuration; it cannot inspect the
// native Windows Explorer dialog visually.
test.describe.serial('TC-HP-015: CT file picker', () => {
  let context: BrowserContext;
  let page: Page;
  test.beforeAll(async ({ browser, baseURL }) => {
    context = await browser.newContext({ baseURL });
    context.setDefaultTimeout(15_000);
    page = await context.newPage();
    await signIn(page, USERS.hospital);
  });
  test.afterAll(async () => { await context?.close(); });

  test('Default chooser filter offers ZIP and DICOM formats and excludes unsupported extensions', async () => {
    await page.goto('/partner/new');
    const input = page.locator('input[type="file"][accept*=".dcm"]');
    await expect(input).toHaveCount(1);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      input.evaluate(e => (e as HTMLInputElement).click()),
    ]);
    const accept = await chooser.element().getAttribute('accept');
    const formats = accept!.split(',').map(value => value.trim().toLowerCase());
    expect(formats).toEqual(['.zip', '.dcm', 'application/zip']);
    expect(chooser.isMultiple()).toBe(false);
    for (const unsupported of ['.txt', '.exe', '.pdf', '.jpg', '.png', '*/*']) {
      expect(formats).not.toContain(unsupported);
    }
    await chooser.setFiles([]);
    await expect(page.locator('input[name="ctFileId"]')).toHaveValue('');
    const result = { accept, supportedExtensions: ['.zip', '.dcm'],
      unsupportedExtensionsExcluded: true, nativeExplorerVisuallyInspected: false,
      sizeValidation: 'Outside clarified picker-filter scope' };
    await test.info().attach('file-picker-filter', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    await test.info().attach('ct-upload-control', { body: await page.screenshot(), contentType: 'image/png' });
    console.log(JSON.stringify(result));
  });

  test('A valid synthetic CT ZIP can be selected and uploaded', async () => {
    await page.goto('/partner/new');
    const input = page.locator('input[type="file"][accept*=".dcm"]');
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      input.evaluate(e => (e as HTMLInputElement).click()),
    ]);
    const [prepared] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql')
        && r.request().postDataJSON()?.operationName === 'PrepareFileUpload').then(r => r.json()),
      chooser.setFiles({ ...syntheticCtRoundTwo, name: 'tc-hp-015-valid-synthetic-ct.zip' }),
    ]);
    const cooldown = prepared.errors?.find((e: any) => e.extensions?.code === 'RATE_LIMITED');
    if (cooldown) {
      await expect(page.getByRole('alert')).toHaveText(cooldown.message);
      await test.info().attach('upload-cooldown', { body: JSON.stringify({ message: cooldown.message,
        retryAfterSeconds: cooldown.extensions.retryAfterSeconds }, null, 2), contentType: 'application/json' });
      console.log(JSON.stringify({ validFileUpload: 'BLOCKED', retryAfterSeconds: cooldown.extensions.retryAfterSeconds }));
      test.skip(true, 'Upload service cooldown prevents checking valid-file acceptance; chooser filter was verified separately.');
    }
    expect(prepared.errors).toBeUndefined();
    await expect(page.locator('input[name="ctFileId"]')).not.toHaveValue('');
    await expect(page.getByText('tc-hp-015-valid-synthetic-ct.zip', { exact: true }).first()).toBeVisible();
    await test.info().attach('valid-ct-accepted', { body: await page.screenshot(), contentType: 'image/png' });
    console.log(JSON.stringify({ validFileUpload: 'ACCEPTED', bytes: syntheticCtRoundTwo.buffer.length }));
  });
});
