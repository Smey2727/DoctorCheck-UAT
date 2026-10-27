import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Page, test } from '@playwright/test';

// Derive the concrete storage-state result without depending on internal Playwright types.
type Storage = Awaited<ReturnType<ReturnType<Page['context']>['storageState']>>;
type User = { id: string; role: string; [key: string]: any };
type CachedSession = { savedAt: number; user: User; landing: string; storage: Storage };

const directory = resolve('playwright/.auth');
const maxAgeMs = 4 * 60 * 60 * 1000;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function reuseSession(
  page: Page,
  email: string,
  password: string,
  login: () => Promise<User>,
): Promise<User> {
  const baseURL = String(test.info().project.use.baseURL ?? '');
  const browser = page.context().browser()?.browserType().name() ?? test.info().project.name;
  const key = createHash('sha256')
    .update(JSON.stringify([baseURL, browser, email, password]))
    .digest('hex');
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, key + '.json');
  const lock = resolve(directory, key + '.lock');

  // Exclusive creation prevents parallel workers from logging into the same account at once.
  const started = Date.now();
  let waiting = false;
  for (;;) {
    try {
      await writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!waiting) {
        waiting = true;
        const info = test.info();
        if (info.timeout) info.setTimeout(info.timeout + 960_000);
      }
      try {
        const owner = JSON.parse(await readFile(lock, 'utf8'));
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            await rm(lock, { force: true });
            continue;
          }
        }
      } catch {
        // Another process may still be writing its lock record.
      }
      if (Date.now() - started > 960_000)
        throw new Error('Timed out waiting for authentication cache lock');
      await pause(500);
    }
  }

  try {
    let cached: CachedSession | undefined;
    try {
      const value = JSON.parse(await readFile(file, 'utf8')) as CachedSession;
      if (value.user?.id && value.storage && Date.now() - value.savedAt < maxAgeMs) cached = value;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
    }
    if (cached) {
      await page.goto('about:blank');
      await page.context().setStorageState(cached.storage);
      const [identity] = await Promise.all([
        page
          .waitForResponse(
            (response) =>
              response.url().endsWith('/graphql') &&
              response.request().method() === 'POST' &&
              response.request().postDataJSON()?.operationName === 'Me',
            { timeout: 15_000 },
          )
          .then((response) => response.json().catch(() => null)),
        page.goto(cached.landing),
      ]);
      // The shell can briefly render a stored user before the server rejects the token.
      // Only a successful server identity check can validate a cached session.
      if (identity && !identity.errors && identity.data?.me?.id === cached.user.id) {
        await page
          .getByRole('button', { name: 'Sign out', exact: true })
          .waitFor({ timeout: 15_000 });
        // Persist any token refresh performed while the app restored this session.
        cached.storage = await page.context().storageState({ indexedDB: true });
        await writeFile(file, JSON.stringify(cached), { mode: 0o600 });
        test.info().annotations.push({
          type: 'authentication',
          description: 'Reused saved session for ' + email,
        });
        return cached.user;
      }
      await rm(file, { force: true });
    }
    await page.goto('about:blank');
    await page.context().setStorageState({ cookies: [], origins: [] });
    const user = await login();
    const value: CachedSession = {
      user,
      savedAt: Date.now(),
      landing: page.url(),
      storage: await page.context().storageState({ indexedDB: true }),
    };
    await writeFile(file, JSON.stringify(value), { mode: 0o600 });
    test.info().annotations.push({
      type: 'authentication',
      description: 'Created saved session for ' + email,
    });
    return user;
  } finally {
    await rm(lock, { force: true });
  }
}

// Local cleanup deliberately does not call the server's logout mutation.
export async function clearSession(page: Page) {
  await page.goto('about:blank');
  await page.context().setStorageState({ cookies: [], origins: [] });
}
