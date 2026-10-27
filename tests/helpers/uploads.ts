import { Page, test } from '@playwright/test';

// The uploader retries itself after the server's cooldown. Keep the browser open
// and allow that retry instead of re-uploading or masking a failed registration.
export async function waitForUpload(page: Page, complete: () => Promise<boolean>) {
  let deadline = Date.now() + 30_000;
  let extended = false;
  while (!(await complete())) {
    const messages = await page.getByText(/Upload limit reached\. Try again in/).allTextContents();
    const match = messages.join(' ').match(/Try again in (\d+)\s*(min|sec)/);
    if (match && !extended) {
      const seconds = Number(match[1]) * (match[2] === 'min' ? 60 : 1);
      if (seconds > 0 && seconds <= 3600) {
        const allowance = (seconds + 60) * 1000;
        const info = test.info();
        if (info.timeout) info.setTimeout(info.timeout + allowance);
        deadline = Date.now() + allowance;
        extended = true;
        info.annotations.push({
          type: 'upload-cooldown',
          description: `Waiting ${seconds}s for the application's automatic upload retry`,
        });
        console.log(`Upload rate limit: allowing the application to retry after ${seconds}s.`);
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        extended
          ? 'Upload did not finish after the server cooldown and automatic retry.'
          : 'Upload did not finish within 30 seconds.',
      );
    }
    await page.waitForTimeout(500);
  }
}
