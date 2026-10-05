import { expect, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';

test('TC-MG-015: Manager filters by status and searches by exact request number', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page, USERS.manager);
  function queueResponse() {
    return page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Requests').then(async r => {
        expect(r.ok()).toBe(true);
        const body = await r.json();
        expect(body.errors).toBeUndefined();
        return body.data.requests;
      });
  }
  const [initial] = await Promise.all([queueResponse(), page.goto('/manager/requests')]);
  await expect(page.getByRole('heading', { name: 'All requests', exact: true })).toBeVisible();
  const status = page.getByRole('combobox', { name: 'Status', exact: true });
  const search = page.getByRole('textbox', { name: 'Search request, case, hospital, product, agency', exact: true });
  const rows = page.locator('tbody').getByRole('row');
  const matchingIds: string[] = [];
  let target: string;
  await test.step('PRODUCTION_HANDOFF filter returns only matching requests on every page', async () => {
    const [filtered] = await Promise.all([queueResponse(), status.selectOption('PRODUCTION_HANDOFF')]);
    expect(filtered.totalCount).toBeGreaterThan(0);
    expect(filtered.totalCount).toBeLessThan(initial.totalCount);
    let current = filtered;
    while (true) {
      await expect(rows).toHaveCount(current.items.length);
      for (const item of current.items) {
        expect(item.status).toBe('PRODUCTION_HANDOFF');
        const row = rows.filter({ has: page.getByRole('cell', { name: item.requestNo, exact: true }) });
        await expect(row.getByRole('button', { name: 'Production handoff', exact: true })).toBeVisible();
        matchingIds.push(item.requestNo);
      }
      const next = page.getByRole('button', { name: 'Next', exact: true });
      if (matchingIds.length === filtered.totalCount) {
        await expect(next).toBeDisabled();
        break;
      }
      expect(current.items.length).toBeGreaterThan(0);
      [current] = await Promise.all([queueResponse(), next.click()]);
    }
    expect(new Set(matchingIds).size).toBe(filtered.totalCount);
    target = matchingIds[0];
    await test.info().attach('status-filter', { body: JSON.stringify({ status: 'PRODUCTION_HANDOFF', matchingIds }, null, 2), contentType: 'application/json' });
  });
  async function exactResult(result: any) {
    expect(result.totalCount).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ requestNo: target, status: 'PRODUCTION_HANDOFF' });
    await expect(rows).toHaveCount(1);
    await expect(rows.getByRole('cell', { name: target, exact: true })).toBeVisible();
    await expect(rows.getByRole('link', { name: 'Open', exact: true })).toHaveAttribute('href', `/manager/requests/${target}`);
  }
  await test.step('Exact request number search works together with the status filter', async () => {
    const [result] = await Promise.all([queueResponse(), search.fill(target)]);
    await exactResult(result);
    await expect(status).toHaveValue('PRODUCTION_HANDOFF');
    await test.info().attach('combined-search', { body: await page.screenshot(), contentType: 'image/png' });
  });
  await test.step('Exact request number search also works with all statuses', async () => {
    const [result] = await Promise.all([queueResponse(), status.selectOption({ label: 'All statuses' })]);
    await exactResult(result);
    await expect(search).toHaveValue(target);
    await test.info().attach('exact-search', { body: await page.screenshot(), contentType: 'image/png' });
  });
  await test.step('A conflicting status filter excludes the searched request', async () => {
    const [result] = await Promise.all([queueResponse(), status.selectOption('COMPLETED')]);
    expect(result.totalCount).toBe(0);
    expect(result.items).toHaveLength(0);
    await expect(rows.getByRole('cell', { name: target, exact: true })).toHaveCount(0);
  });
  console.log(JSON.stringify({ target, filteredCount: matchingIds.length, result: 'PASSED' }));
});
