import { expect, test } from '@playwright/test';
import { signIn, signOut, USERS } from '../helpers/auth';

test('TC-AU-005: Hospital, Agency and Counselor cannot access Manager user setup', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  let managerQuery: object;
  let graphqlUrl: string;
  const results: object[] = [];

  await test.step('Manager can open user setup and retrieve its data', async () => {
    await signIn(page, USERS.manager);
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/graphql')
        && r.request().postDataJSON()?.operationName === 'Users'),
      page.goto('/manager/users'),
    ]);
    const body = await response.json();
    expect(body.errors).toBeUndefined();
    expect(body.data).toBeTruthy();
    expect(JSON.stringify(body.data)).toContain(USERS.manager);
    managerQuery = response.request().postDataJSON();
    graphqlUrl = response.url();
    await expect(page.getByRole('button', { name: '+ New account', exact: true })).toBeVisible();
    await signOut(page);
  });

  for (const role of ['hospital', 'agency', 'counselor'] as const) {
    await test.step(`${role}: direct Manager URL and setup API deny access`, async () => {
      const context = await browser.newContext({ baseURL });
      try {
        const actor = await context.newPage();
        actor.setDefaultTimeout(15_000);
        let ownRequest: { url: string; data: object; headers: Record<string, string> } | undefined;
        actor.on('request', request => {
          if (request.url().endsWith('/graphql') && request.method() === 'POST'
            && request.postDataJSON()?.operationName === 'Requests') {
            const authorization = request.headers().authorization;
            ownRequest = { url: request.url(), data: request.postDataJSON(),
              headers: authorization ? { authorization } : {} };
          }
        });
        const user = await signIn(actor, USERS[role]);
        expect(user.role).toBe(role === 'counselor' ? 'COUNSELOR' : 'PARTNER');
        // The saved authenticated request proves the API check uses this role's session.
        await expect.poll(() => Boolean(ownRequest)).toBe(true);
        const ownResponse = await context.request.post(ownRequest!.url, {
          data: ownRequest!.data, headers: ownRequest!.headers,
        });
        expect(ownResponse.ok()).toBe(true);
        const ownBody = await ownResponse.json();
        expect(ownBody.errors).toBeUndefined();
        expect(ownBody.data.requests).toBeTruthy();

        await actor.goto('/manager/users');
        // The app can deny access by redirecting to the role's own workspace.
        await expect(actor).toHaveURL(role === 'counselor'
          ? /\/counselor(?:\?|$)/ : /\/partner\/requests(?:\?|$)/);
        await expect(actor.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
        await expect(actor.getByRole('button', { name: '+ New account', exact: true })).toHaveCount(0);
        await expect(actor.getByRole('textbox', { name: 'Search name, email, login, organization, phone', exact: true })).toHaveCount(0);
        await expect(actor.locator('body')).not.toContainText(USERS.manager);

        const deniedResponse = await context.request.post(graphqlUrl, {
          data: managerQuery, headers: ownRequest!.headers,
        });
        expect(deniedResponse.status()).toBe(200);
        const denied = await deniedResponse.json();
        expect(denied.errors?.length).toBeGreaterThan(0);
        expect(Object.values(denied.data ?? {}).every(value => value === null)).toBe(true);
        expect(denied.errors.some((error: any) => /forbidden|access.denied|permission/i.test(
          `${error.message} ${error.extensions?.classification} ${error.extensions?.code}`
        ))).toBe(true);
        await test.info().attach(`${role}-manager-access-blocked`, { body: await actor.screenshot(), contentType: 'image/png' });
        const result = { role, managerUrl: '/manager/users', redirectedTo: new URL(actor.url()).pathname,
          managerControlsAbsent: true, setupApiDenied: true,
          apiError: denied.errors[0].message,
          visibleAccessDeniedMessage: await actor.getByText(/access denied/i).count() > 0 };
        results.push(result);
        console.log(JSON.stringify(result));
        await signOut(actor);
      } finally {
        await context.close();
      }
    });
  }
  await test.info().attach('role-access-results', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
});
