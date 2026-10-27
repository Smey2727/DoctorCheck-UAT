import { expect, test } from '@playwright/test';
import { signIn, clearSession } from './helpers/auth';
import { waitForGraphqlResponse } from './helpers/graphql';
import { reuseSession } from './helpers/auth-state';

test('Saved authentication is reused across isolated contexts without repeated Login mutations', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all(
    Array.from({ length: 3 }, () => browser.newContext({ baseURL })),
  );
  let logins = 0;
  for (const context of contexts) {
    context.setDefaultTimeout(15_000);
    context.on('request', (request) => {
      if (
        request.url().endsWith('/graphql') &&
        request.method() === 'POST' &&
        request.postDataJSON()?.operationName === 'Login'
      )
        logins++;
    });
  }
  try {
    const [first, second, third] = await Promise.all(contexts.map((context) => context.newPage()));
    const original = await signIn(first, 'hospital.c@saerosoft.com');
    const initialLogins = logins;
    await first.evaluate(() => localStorage.setItem('uat-context-isolation', 'first only'));
    const [reused, another] = await Promise.all([
      signIn(second, 'hospital.c@saerosoft.com'),
      signIn(third, 'hospital.c@saerosoft.com'),
    ]);
    expect(reused.id).toBe(original.id);
    expect(another.id).toBe(original.id);
    expect(logins - initialLogins).toBe(process.env.UAT_REUSE_AUTH === '0' ? 2 : 0);
    expect(await second.evaluate(() => localStorage.getItem('uat-context-isolation'))).toBeNull();
    await clearSession(first);
    await first.goto('/partner/requests');
    await expect(first).toHaveURL(/\/login/);
    const [body] = await Promise.all([
      waitForGraphqlResponse(second, 'FinancialAgency').then((response) => response.json()),
      second.goto('/partner/new'),
    ]);
    expect(body.errors).toBeUndefined();
    expect(body.data.financialAgency).toBeNull();
    await expect(
      second.getByRole('textbox', { name: /^Hospital Set from your account/ }),
    ).toHaveValue('Hospital C Medical Center');
    await third.reload();
    await expect(third.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    console.log(
      JSON.stringify({
        initialLogins,
        additionalLogins: logins - initialLogins,
        contextsIsolated: true,
        localCleanupPreservesOtherSessions: true,
      }),
    );
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test('A rejected cached session performs one fresh login and replaces the stale state', async ({
  page,
}) => {
  // Intercept every navigation: exercise recovery without sending real login requests.
  const { randomUUID, createHash } = await import('node:crypto');
  const { rm } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const identity = 'cache-recovery-' + randomUUID();
  let acceptedToken = 'first';
  let logins = 0;
  await page.route('**/*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/graphql') {
      const token = route.request().postDataJSON()?.token;
      await route.fulfill({
        json: { data: { me: token === acceptedToken ? { id: identity } : null } },
      });
      return;
    }
    await route.fulfill({
      contentType: 'text/html',
      body:
        path === '/login'
          ? '<label>ID or email*<input></label>'
          : '<script>fetch("/graphql",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({operationName:"Me",token:localStorage.getItem("probe-token")})}).then(r=>r.json()).then(b=>{if(!b.data.me)location.replace("/login")});</script><button>Sign out</button>',
    });
  });
  const fresh = async () => {
    logins++;
    await page.goto('/login');
    await page.evaluate((token) => localStorage.setItem('probe-token', token), acceptedToken);
    await page.goto('/cache-probe');
    return { id: identity, role: 'PARTNER' };
  };
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        String(test.info().project.use.baseURL ?? ''),
        page.context().browser()!.browserType().name(),
        identity,
        '',
      ]),
    )
    .digest('hex');
  try {
    await reuseSession(page, identity, '', fresh);
    expect(logins).toBe(1);
    await reuseSession(page, identity, '', fresh);
    expect(logins).toBe(1);
    acceptedToken = 'replacement';
    await reuseSession(page, identity, '', fresh);
    expect(logins).toBe(2);
    await reuseSession(page, identity, '', fresh);
    expect(logins).toBe(2);
  } finally {
    await rm(resolve('playwright/.auth', key + '.json'), { force: true });
  }
});
