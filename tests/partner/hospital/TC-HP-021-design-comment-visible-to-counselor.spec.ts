import { randomUUID } from 'node:crypto';
import { expect, Page, test } from '@playwright/test';
import { signIn, USERS } from '../../helpers/auth';

// Synthetic Hospital C case shared by TC-HP-016; no file upload is needed.
const REQUEST = 'REQ-2026-0730';

async function loadRequest(page: Page, role: 'partner' | 'counselor') {
  const [body] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith('/graphql')
      && r.request().postDataJSON()?.operationName === 'Request').then(r => r.json()),
    page.goto(`/${role}/requests/${REQUEST}`),
  ]);
  expect(body.errors).toBeUndefined();
  expect(body.data.request.details.requestNo).toBe(REQUEST);
  return body.data.request.details;
}

test('TC-HP-021: Hospital design comment reaches Counselor with author and time without changing status', async ({ page, browser, baseURL }) => {
  test.setTimeout(90_000);
  page.setDefaultTimeout(15_000);
  const counselorContext = await browser.newContext({ baseURL });
  counselorContext.setDefaultTimeout(15_000);
  try {
    const hospital = await signIn(page, 'hospital.c@saerosoft.com');
    const before = await loadRequest(page, 'partner');
    expect(before.status).toBe('REVIEW_REQUESTED');
    await page.getByRole('link', { name: 'Open 3D result', exact: true }).first().click();
    await expect(page.getByRole('button', { name: /^v1 .*Design result Shared/ })).toBeVisible();
    const comment = `TC-HP-021-${randomUUID().slice(0, 8)}: Please verify the shared design edge fit. Synthetic Hospital feedback.`;
    await page.getByRole('textbox', { name: 'Write a comment...', exact: true }).fill(comment);
    const [created] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql')
        && /mutation/.test(r.request().postDataJSON()?.query ?? '')).then(r => r.json()),
      page.getByRole('button', { name: 'Send', exact: true }).click(),
    ]);
    expect(created.errors).toBeUndefined();
    await expect(page.getByText(comment, { exact: true })).toBeVisible();
    const savedComment = created.data.addModelComment;
    expect(savedComment).toMatchObject({ requestId: before.id, body: comment,
      authorUserId: hospital.id, authorRole: 'PARTNER', visibility: 'SHARED' });
    expect(Number.isNaN(Date.parse(savedComment.createdAt))).toBe(false);
    const after = await loadRequest(page, 'partner');
    expect(after.status).toBe('REVIEW_REQUESTED');
    expect(after.statusHistory).toEqual(before.statusHistory);

    const counselor = await counselorContext.newPage();
    await signIn(counselor, USERS.counselor);
    expect((await loadRequest(counselor, 'counselor')).status).toBe('REVIEW_REQUESTED');
    await counselor.getByRole('link', { name: 'Open 3D result', exact: true }).first().click();
    await expect(counselor.getByText(comment, { exact: true })).toBeVisible();
    const card = counselor.getByText(comment, { exact: true }).locator('..');
    await expect(card.getByText('Partner', { exact: true })).toBeVisible();
    const expectedTime = await counselor.evaluate(iso => new Date(iso).toLocaleString('en-US'), savedComment.createdAt);
    await expect(card.locator('time')).toHaveText(expectedTime);
    const result = { requestId: REQUEST, comment, authorLabel: 'Partner',
      savedAuthor: hospital.displayName, savedAuthorIdMatchesHospital: true,
      displayedTime: await card.locator('time').innerText(), createdAt: savedComment.createdAt,
      counselorCanSeeComment: true, status: 'REVIEW_REQUESTED' };
    await test.info().attach('counselor-sees-design-comment', { body: await counselor.screenshot(), contentType: 'image/png' });
    const persisted = await loadRequest(counselor, 'counselor');
    expect(persisted.status).toBe('REVIEW_REQUESTED');
    expect(persisted.statusHistory).toEqual(before.statusHistory);
    await test.info().attach('comment-visibility-results', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    test.info().annotations.push({ type: 'request', description: REQUEST });
    console.log(JSON.stringify(result));
  } finally {
    await counselorContext.close();
  }
});
