import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { signIn, USERS } from '../../helpers/auth';

// Synthetic request whose second shared revision was approved by TC-HP-010.
const REQUEST = 'REQ-2026-0702';

test('TC-HP-020: Approved Drawing downloads and opens for the approved revision', async ({ page }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  await signIn(page, USERS.hospital);
  const [requestBody, documentsBody] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    page.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'Documents').then(r => r.json()),
    page.goto(`/partner/requests/${REQUEST}`),
  ]);
  expect(requestBody.errors).toBeUndefined();
  expect(documentsBody.errors).toBeUndefined();
  const request = requestBody.data.request.details;
  const drawings = documentsBody.data.documents.filter((d: any) => d.documentType === 'APPROVED_DRAWING');
  expect(drawings).toHaveLength(1);
  const drawing = drawings[0];
  const approvedRevision = request.attachments.find((a: any) => a.id === drawing.sourceAttachmentId);
  expect(approvedRevision).toMatchObject({ category: 'DESIGN_RESULT', version: 2 });
  expect(drawing.generatedFile).toMatchObject({ contentType: 'application/pdf', status: 'AVAILABLE' });
  expect(drawing.file.originalName).toBe(approvedRevision.file.originalName);
  await page.getByRole('button', { name: /^Files & 3D(?:,|$)/ }).click();
  await expect(page.getByRole('heading', { name: 'Files & 3D deliverables', exact: true })).toBeVisible();
  await test.info().attach('files-and-3d-deliverables', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('link', { name: 'Open 3D result', exact: true }).first().click();
  await test.info().attach('files-and-3d', { body: await page.screenshot(), contentType: 'image/png' });
  await test.info().attach('viewer-accessibility', { body: await page.locator('body').ariaSnapshot(), contentType: 'text/plain' });
  const card = page.getByRole('article').filter({ has: page.getByRole('button', { name: /^v2 .*Design result Shared/ }) });
  await expect(card.getByText('Approved', { exact: true })).toBeVisible();
  await page.goto(`/partner/requests/${REQUEST}`);
  await page.getByRole('link', { name: 'Documents / print', exact: true }).click();
  const row = page.getByRole('listitem').filter({ hasText: 'Approved Drawing' });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Open', exact: true }).click();
  const preview = page.getByRole('dialog', { name: 'Approved Drawing print view', exact: true });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(drawing.documentNo);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    preview.getByRole('button', { name: 'Download PDF', exact: true }).click(),
  ]);
  expect(await download.failure()).toBeNull();
  const pdfPath = test.info().outputPath('approved-drawing.pdf');
  await download.saveAs(pdfPath);
  const pdf = await readFile(pdfPath);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  const parsed = JSON.parse(execFileSync('python', ['-c',
    'import sys,json; sys.path.insert(0,sys.argv[1]); from pypdf import PdfReader; r=PdfReader(sys.argv[2]); print(json.dumps({"pages":len(r.pages),"text":"\\n".join(p.extract_text() or "" for p in r.pages)}))',
    resolve('.uat-tools/python'), pdfPath], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }));
  expect(parsed.pages).toBeGreaterThan(0);
  expect(parsed.text).toContain(REQUEST);
  expect(parsed.text).toContain(drawing.documentNo);
  expect(parsed.text).toContain(approvedRevision.file.originalName);
  expect(parsed.text).toMatch(/Approved \/ 승인[\s\S]*?v2/);
  await test.info().attach('approved-drawing-pdf', { body: pdf, contentType: 'application/pdf' });
  await test.info().attach('approved-drawing-text', { body: parsed.text, contentType: 'text/plain' });
  const result = { request: REQUEST, approvedRevision: approvedRevision.version, document: drawing.documentNo,
    sourceFile: drawing.file.originalName, downloadSucceeded: true, pdfPages: parsed.pages, pdfText: parsed.text };
  await test.info().attach('drawing-verification', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  console.log(JSON.stringify(result));
});
