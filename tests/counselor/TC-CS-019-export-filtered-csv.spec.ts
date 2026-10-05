import { readFile } from 'node:fs/promises';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';

// CSV fields can contain commas, escaped quotes and embedded newlines.
function parseCsv(source: string): string[][] {
  const text = source.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field); field = '';
    } else if ((character === '\r' || character === '\n') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += character;
  }
  expect(quoted, 'CSV must not contain an unterminated quoted field').toBe(false);
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

interface QueueItem {
  requestNo: string; patientCode: string; surgeryDate: string;
  productCategory: string | null; product: string; material: string;
  hospital: string; agencyNames: string[]; status: string; counselorName: string | null;
}
interface QueuePage { items: QueueItem[]; totalCount: number; page: number; size: number; }

function waitForQueue(page: Page, pageNumber: number, hospitalId?: string) {
  return page.waitForResponse(response => {
    if (!response.url().endsWith('/graphql')) return false;
    const body = response.request().postDataJSON();
    return body?.operationName === 'CounselorRequestQueue'
      && body.variables.input.page === pageNumber
      && JSON.stringify(body.variables.input.statuses) === '["SUBMITTED"]'
      && (body.variables.input.hospitalId ?? undefined) === hospitalId;
  }).then(async response => {
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    return body.data.requests as QueuePage;
  });
}

async function collectQueue(page: Page, first: QueuePage, hospitalId?: string) {
  const expected: QueueItem[] = [];
  let current = first;
  while (true) {
    expect(current.totalCount).toBe(first.totalCount);
    await expect(page.locator('tbody').getByRole('row')).toHaveCount(current.items.length);
    for (const item of current.items) {
      expect(item.status).toBe('SUBMITTED');
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: item.requestNo, exact: true }) });
      await expect(row.getByRole('cell', { name: 'Submitted', exact: true })).toBeVisible();
      expected.push(item);
    }
    const next = page.getByRole('button', { name: 'Next', exact: true });
    if (expected.length === first.totalCount) { await expect(next).toBeDisabled(); break; }
    expect(current.items.length).toBeGreaterThan(0);
    await expect(next).toBeEnabled();
    [current] = await Promise.all([waitForQueue(page, current.page + 1, hospitalId), next.click()]);
  }
  expect(new Set(expected.map(item => item.requestNo)).size).toBe(first.totalCount);
  return expected;
}

async function verifyExport(page: Page, expected: QueueItem[]) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export filtered CSV', exact: true }).click(),
  ]);
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe('doctorcheck-counselor-queue.csv');
  const file = await download.path();
  expect(file).toBeTruthy();
  const [header, ...rows] = parseCsv(await readFile(file!, 'utf8'));
  expect(header).toEqual(['Request no', 'Patient', 'Surgery date', 'Product category',
    'Product', 'Material', 'Hospital', 'Agencies', 'Status', 'Counselor', 'Next action']);
  expect(rows).toHaveLength(expected.length);
  const byId = new Map(expected.map(item => [item.requestNo, item]));
  expect(rows.map(row => row[0]).sort()).toEqual([...byId.keys()].sort());
  for (const row of rows) {
    expect(row).toHaveLength(header.length);
    const item = byId.get(row[0])!;
    const date = new Date(`${item.surgeryDate.slice(0, 10)}T12:00:00Z`);
    expect(row).toEqual([item.requestNo, item.patientCode,
      new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).format(date),
      item.productCategory ?? '', item.product, item.material, item.hospital,
      item.agencyNames.join('; '), 'Submitted', item.counselorName ?? '', 'Counselor review queue']);
  }
  return rows;
}

// Read-only reporting test: compare the download against every page of the UI,
// then apply a hospital scope explicitly (Status alone does not select a hospital).
test('TC-CS-019: Filtered CSV contains only matching requests and correct columns', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, USERS.counselor);
  const [unfiltered] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'CounselorRequestQueue'
      && r.request().postDataJSON()?.variables.input.statuses.length === 0).then(r => r.json()),
    page.goto('/counselor/requests'),
  ]);
  expect(unfiltered.errors).toBeUndefined();
  expect(unfiltered.data.requests.statusCounts.some((entry: { status: string; count: number }) =>
    entry.status !== 'SUBMITTED' && entry.count > 0), 'Queue includes non-Submitted records that the export must exclude').toBe(true);
  await expect(page.getByRole('heading', { name: 'My queue', exact: true })).toBeVisible();
  const [first] = await Promise.all([
    waitForQueue(page, 0),
    page.getByRole('combobox', { name: 'Status', exact: true }).selectOption({ label: 'Submitted' }),
  ]);
  expect(first.totalCount, 'UAT needs at least one Submitted request to verify a nonempty export').toBeGreaterThan(0);
  let submitted: QueueItem[] = [];
  await test.step('Export all Submitted rows across queue pages', async () => {
    submitted = await collectQueue(page, first);
    await verifyExport(page, submitted);
  });
  await test.step('Hospital filter excludes all other hospitals from the CSV', async () => {
    const hospitalName = submitted[0].hospital;
    const hospital = page.getByRole('combobox', { name: 'Hospital', exact: true });
    const option = hospital.getByRole('option', { name: hospitalName, exact: true });
    const hospitalId = await option.getAttribute('value');
    expect(hospitalId).toBeTruthy();
    const [filtered] = await Promise.all([
      waitForQueue(page, 0, hospitalId!),
      hospital.selectOption({ value: hospitalId! }),
    ]);
    const expected = await collectQueue(page, filtered, hospitalId!);
    expect(expected.map(item => item.requestNo).sort()).toEqual(
      submitted.filter(item => item.hospital === hospitalName).map(item => item.requestNo).sort());
    const rows = await verifyExport(page, expected);
    for (const row of rows) expect(row[6]).toBe(hospitalName);
    test.info().annotations.push({ type: 'export', description:
      `${submitted.length} Submitted rows; ${rows.length} rows for ${hospitalName}; ${new Set(submitted.map(item => item.hospital)).size} hospitals in Submitted queue.` });
  });
});
