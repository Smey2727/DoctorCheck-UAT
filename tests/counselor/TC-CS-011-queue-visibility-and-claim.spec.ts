import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';
import { createHospitalReworkRequest } from '../helpers/requests';

function requestRow(page: Page, requestId: string) {
  return page.getByRole('row').filter({
    has: page.getByRole('cell', { name: requestId, exact: true }),
  });
}

async function openQueue(page: Page, caseCode: string) {
  await page.goto('/counselor/requests');
  await page.getByRole('searchbox', { name: /^Search request no\./ }).fill(caseCode);
}

async function expectUnassigned(page: Page, requestId: string) {
  const row = requestRow(page, requestId);
  await expect(row).toBeVisible();
  await expect(row.getByRole('cell', { name: 'Submitted', exact: true })).toBeVisible();
  await expect(row.getByRole('cell', { name: 'Unassigned', exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Claim', exact: true })).toBeEnabled();
}

// Two independent requests and two different counselor accounts prevent a
// shared login or an old assignment from masking queue isolation failures.
test('TC-CS-011: Claiming one request preserves visibility of another unassigned request', async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000);
  const hospitalContext = await browser.newContext({ baseURL });
  const otherContext = await browser.newContext({ baseURL });
  try {
    const caseCode = `TC-CS-011-${randomUUID().slice(0, 8)}`;
    const hospitalPage = await hospitalContext.newPage();
    await signIn(hospitalPage, USERS.hospital);
    const first = await createHospitalReworkRequest(hospitalPage, `${caseCode}-A`);
    const second = await createHospitalReworkRequest(hospitalPage, `${caseCode}-B`);
    expect(first).not.toBe(second);
    test.info().annotations.push({ type: 'requests', description: `${first}, ${second}` });
    await hospitalPage.close();

    const owner = await signIn(page, USERS.counselor);
    const otherPage = await otherContext.newPage();
    const other = await signIn(otherPage, USERS.counselorReview);
    expect(owner.role).toBe('COUNSELOR');
    expect(other.role).toBe('COUNSELOR');
    expect(owner.id).not.toBe(other.id);

    await test.step('Both counselors can see both unassigned requests', async () => {
      for (const counselorPage of [page, otherPage]) {
        await openQueue(counselorPage, caseCode);
        await expectUnassigned(counselorPage, first);
        await expectUnassigned(counselorPage, second);
      }
    });
    await test.step('Claim only the first request', async () => {
      const row = requestRow(page, first);
      await row.getByRole('button', { name: 'Claim', exact: true }).click();
      await expect(row.getByRole('cell', { name: owner.displayName, exact: true })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Claim', exact: true })).toHaveCount(0);
      await expectUnassigned(page, second);
    });
    await test.step('Reload both queues and verify assignment and visibility persist', async () => {
      for (const counselorPage of [page, otherPage]) {
        await openQueue(counselorPage, caseCode);
        const claimed = requestRow(counselorPage, first);
        await expect(claimed.getByRole('cell', { name: owner.displayName, exact: true })).toBeVisible();
        await expect(claimed.getByRole('cell', { name: 'Submitted', exact: true })).toBeVisible();
        await expectUnassigned(counselorPage, second);
      }
    });
  } finally {
    await hospitalContext.close();
    await otherContext.close();
  }
});
