import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../helpers/auth';
import { createHospitalReworkRequest } from '../helpers/requests';
import { syntheticCtRoundTwo } from '../helpers/synthetic-ct';

function currentStatus(page: Page, requestId: string, status: string) {
  return page.getByRole('heading', { name: requestId, exact: true }).locator('..')
    .getByRole('button', { name: status, exact: true });
}

async function startReview(page: Page, requestId: string, note: string) {
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Optional note for the status history', exact: true });
  await input.fill(note);
  await input.locator('..').getByRole('button', { name: 'Start review', exact: true }).click();
  await expect(input).toBeHidden();
  await expect(currentStatus(page, requestId, 'In review')).toBeVisible();
}

// TC-CS-013: Accept an exact CT/ETC combination across two submission rounds.
test('TC-CS-013: Counselor accepts CT from Round 1 and ETC from Round 2 without changing status', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const hospitalContext = await browser.newContext({ baseURL });
  try {
    const caseCode = `TC-CS-013-${randomUUID().slice(0, 8)}`;
    const submissionPage = await hospitalContext.newPage();
    await signIn(submissionPage, USERS.hospital);
    const requestId = await createHospitalReworkRequest(submissionPage, caseCode, { ...syntheticCtRoundTwo, name: `${caseCode}-round-1-ct.zip` });
    test.info().annotations.push({ type: 'request', description: requestId });
    await submissionPage.close();

    await test.step('Review Round 1 and request missing supporting details', async () => {
      await signIn(page, USERS.counselor);
      await page.goto('/counselor/requests');
      await page.getByRole('searchbox', { name: /^Search request no\./ }).fill(requestId);
      const row = page.getByRole('row').filter({
        has: page.getByRole('cell', { name: requestId, exact: true }),
      });
      await expect(row.getByRole('cell', { name: 'Submitted', exact: true })).toBeVisible();
      const claim = row.getByRole('button', { name: 'Claim', exact: true });
      await claim.click();
      await expect(claim).toBeHidden();
      await page.goto(`/counselor/requests/${requestId}`);
      await startReview(page, requestId, `${caseCode}: review Round 1`);
      await page.getByRole('button', { name: 'Request rework', exact: true }).click();
      await page.getByRole('textbox', { name: 'Explain what the partner needs to fix', exact: true })
        .fill(`${caseCode}: Please add the missing supporting ETC document in a new round.`);
      await page.getByRole('button', { name: 'Send rework request', exact: true }).click();
      await expect(currentStatus(page, requestId, 'Rework requested')).toBeVisible();
    });

    await test.step('Hospital submits new CT and ETC files as Round 2', async () => {
      const hospitalPage = await hospitalContext.newPage();
      await hospitalPage.goto(`/partner/requests/${requestId}`);
      await hospitalPage.getByRole('link', { name: 'Fix & resubmit', exact: true }).click();
      await hospitalPage.getByRole('textbox', { name: 'Case description', exact: true })
        .fill(`${caseCode}: Synthetic CT verification test. No patient data; not for clinical use.`);
      await hospitalPage.locator('input[type="file"][accept*=".dcm"]').setInputFiles({ ...syntheticCtRoundTwo, name: `${caseCode}-round-2-ct.zip` });
      const etcInput = hospitalPage.locator('input[type="file"]:not([accept*=".dcm"])');
      await etcInput.setInputFiles({ name: `${caseCode}-round-2-etc.png`, mimeType: 'image/png',
        buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64') });
      await expect(hospitalPage.getByText(`${caseCode}-round-2-etc.png`, { exact: true }).first()).toBeVisible();
      await hospitalPage.getByRole('button', { name: 'Resubmit request', exact: true }).first().click();
      const confirmation = hospitalPage.getByRole('alertdialog');
      await confirmation.getByRole('checkbox', { name: /^I reviewed the case details and files/ }).check();
      await confirmation.getByRole('button', { name: 'Resubmit request', exact: true }).click();
      await expect(hospitalPage).toHaveURL(new RegExp(`/partner/requests/${requestId}$`));
      await expect(currentStatus(hospitalPage, requestId, 'Submitted')).toBeVisible();
      await hospitalPage.close();
    });

    await page.goto(`/counselor/requests/${requestId}`);
    await startReview(page, requestId, `${caseCode}: review Round 2`);
    await page.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
    const ctName = `${caseCode}-round-1-ct.zip`;
    const etcName = `${caseCode}-round-2-etc.png`;
    const [historyBody] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'RequestSourceHistory').then(r => r.json()),
      page.reload(),
    ]);
    expect(historyBody.errors).toBeUndefined();
    const before = historyBody.data.requestSourceHistory;
    expect(before.rounds).toHaveLength(2);
    const firstRound = before.rounds.find((round: any) => round.roundNumber === 1);
    const secondRound = before.rounds.find((round: any) => round.roundNumber === 2);
    const ct = firstRound.attachments.find((file: any) => file.category === 'CT' && file.file.originalName === ctName);
    const etc = secondRound.attachments.find((file: any) => file.category === 'ETC' && file.file.originalName === etcName);
    expect(ct).toBeDefined();
    expect(etc).toBeDefined();
    expect(secondRound.attachments.some((file: any) => file.id === ct.id)).toBe(false);
    expect(firstRound.attachments.some((file: any) => file.id === etc.id)).toBe(false);
    const selectedIds = [ct.id, etc.id].sort();
    const selectionReason = `${caseCode}: Retain verified CT from Round 1 and use supporting ETC from Round 2.`;
    await test.step('Select Round 1 CT and Round 2 ETC explicitly', async () => {
      await expect(async () => {
        await page.reload();
        await page.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
        await page.getByText('Choose exact files instead', { exact: true }).click();
        const selection = page.locator('details').filter({ has: page.getByText('Choose exact files instead', { exact: true }) });
        // Clear defaults so the accepted set contains exactly these two files.
        for (const checkbox of await selection.getByRole('checkbox').all()) await checkbox.uncheck();
        await selection.getByRole('checkbox', { name: new RegExp(ctName.replace(/\./g, '\\.')) }).check();
        await selection.getByRole('checkbox', { name: new RegExp(etcName.replace(/\./g, '\\.')) }).check();
        await expect(selection.locator('input[type="checkbox"]:checked')).toHaveCount(2);
        await selection.getByRole('textbox', { name: 'Reason for using a different source set', exact: true }).fill(selectionReason);
        await expect(selection.getByRole('button', { name: 'Save accepted files', exact: true })).toBeEnabled({ timeout: 1000 });
      }).toPass({ timeout: 60000, intervals: [1000, 2000, 5000] });
    });
    let decisionId: string;
    await test.step('Save the exact cross-round set without changing In review', async () => {
      const [body] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'AcceptRequestSource').then(r => r.json()),
        page.getByRole('button', { name: 'Save accepted files', exact: true }).click(),
      ]);
      expect(body.errors).toBeUndefined();
      const decisions = body.data.acceptRequestSource.acceptances.filter((decision: any) => decision.current);
      expect(decisions).toHaveLength(1);
      const decision = decisions[0];
      decisionId = decision.id;
      expect(decision.reason).toBe(selectionReason);
      expect(decision.attachments.map((file: any) => file.id).sort()).toEqual(selectedIds);
      expect(decision.attachments.map((file: any) => file.file.originalName).sort()).toEqual([ctName, etcName].sort());
      await expect(currentStatus(page, requestId, 'In review')).toBeVisible();
    });
    await test.step('Reload and verify the accepted files retain their original round provenance', async () => {
      const verify = await page.context().newPage();
      try {
        const [history, request] = await Promise.all([
          verify.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'RequestSourceHistory').then(r => r.json()),
          verify.waitForResponse(r => r.url().endsWith('/graphql') && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
          verify.goto(`/counselor/requests/${requestId}`),
        ]);
        expect(history.errors).toBeUndefined();
        expect(request.errors).toBeUndefined();
        expect(request.data.request.details.status).toBe('IN_REVIEW');
        const persisted = history.data.requestSourceHistory;
        const decision = persisted.acceptances.find((item: any) => item.id === decisionId);
        expect(decision.current).toBe(true);
        expect(decision.reason).toBe(selectionReason);
        expect(decision.attachments.map((file: any) => file.id).sort()).toEqual(selectedIds);
        for (const [roundId, file] of [[firstRound.id, ct], [secondRound.id, etc]]) {
          const round = persisted.rounds.find((item: any) => item.id === roundId);
          expect(round.attachments).toEqual(expect.arrayContaining([expect.objectContaining({
            id: file.id, category: file.category, file: expect.objectContaining({ id: file.file.id, originalName: file.file.originalName }),
          })]));
        }
        await verify.getByRole('button', { name: /^Submission(?:,|$)/ }).click();
        const card = verify.getByRole('article').filter({ hasText: ctName }).filter({ hasText: etcName });
        await expect(card).toHaveCount(1);
        await expect(card.getByRole('listitem')).toHaveCount(2);
        await expect(card.getByText(ctName, { exact: true })).toBeVisible();
        await expect(card.getByText(etcName, { exact: true })).toBeVisible();
        await expect(currentStatus(verify, requestId, 'In review')).toBeVisible();
      } finally { await verify.close(); }
    });
  } finally { await hospitalContext.close(); }
});
