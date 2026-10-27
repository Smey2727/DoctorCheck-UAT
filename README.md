# DoctorCheck UAT tests

This project uses Playwright and TypeScript to check DoctorCheck in a browser.
Each `*.spec.ts` file describes a user scenario and checks the expected result.
The configured application is `https://doctorcheck.saerosoft.com`.

To test a different deployment, set `BASE_URL` before running Playwright:

```powershell
$env:BASE_URL = 'https://your-staging-host'
npm run test:chromium -- tests/auth/TC-AU-004-logout-clears-session.spec.ts
```

Login and other navigation use this same URL. Run `Remove-Item Env:BASE_URL` to return
to the default site.

## First run

Install Node.js and npm, then run these commands from the project folder:

```powershell
npm ci
npx playwright install chromium firefox
npm run test:chromium -- tests/auth/TC-AU-004-logout-clears-session.spec.ts
```

The tests use UAT accounts and synthetic data. Some scenarios create requests,
change passwords, or temporarily change shared settings. Run the test you are
working on first. Tests that change settings contain cleanup in `finally` blocks.

## Reusable authentication

Ordinary tests use `signIn()` to reuse a saved session per account, browser engine,
and configured site URL. Each test still has its own browser context. Cache files
live in the Git-ignored `playwright/.auth/` directory and contain sensitive session
tokens: do not upload or share them. Sessions are reused for up to four hours.
The helper checks the restored session in the application and performs a real
login if the app redirects it to login. An account lock prevents simultaneous
workers from creating duplicate sessions.

Authentication, concurrent-login, and draft-across-login tests use `signInFresh()`
so their login/logout assertions remain real. Generated accounts and custom
passwords also use fresh login. `signOut()` always logs out on the server; use
`clearSession()` only for local cleanup or switching roles in ordinary tests.
Local cleanup does not revoke sessions being reused elsewhere. Browser isolation
does not isolate server-side data: shared pricing/account changes still need coordination.

To disable reuse, set `$env:UAT_REUSE_AUTH = '0'`. Run
`Remove-Item Env:UAT_REUSE_AUTH` to enable it again. To force cache renewal, delete
only the files inside `playwright/.auth/` while no tests are running.

Verify reuse and context isolation with:

```powershell
npx playwright test auth-cache --workers=1 --retries=0 --reporter=list
```

## Test commands

| Command                                                                       | Purpose                                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `npm run test:chromium -- tests/auth/TC-AU-004-logout-clears-session.spec.ts` | Run one file in Chromium                                   |
| `npm run test:chromium -- --workers=1`                                        | Run Chromium tests one at a time                           |
| `npm run test:firefox`                                                        | Run Firefox tests                                          |
| `npm test`                                                                    | Run the full suite in both configured browsers             |
| `npm run test:ui`                                                             | Open Playwright's interactive test runner                  |
| `npm run test:list`                                                           | List tests without running them                            |
| `npm run report`                                                              | Open the HTML report after a test run                      |
| `npm run check`                                                               | Check TypeScript and formatting without opening a browser  |
| `npm run format`                                                              | Format the TypeScript, JSON configuration, and this README |

Pass `--headed` after `--` to watch the browser while a test runs.
Failed test screenshots and videos are saved in `test-results/`.

## Where to find things

| Location                           | What it contains                                                    |
| ---------------------------------- | ------------------------------------------------------------------- |
| `tests/auth/`                      | Login, logout, password, and access checks                          |
| `tests/manager/`                   | Manager setup, pricing, production, and billing checks              |
| `tests/counselor/`                 | Review, design, and counselor workflow checks                       |
| `tests/partner/hospital/`          | Hospital request checks                                             |
| `tests/partner/agency/`            | Agency visibility, request, and billing checks                      |
| `tests/helpers/auth.ts`            | Test accounts, sign-in, sign-out, and language selection            |
| `tests/helpers/requests.ts`        | Fill and submit a synthetic hospital request                        |
| `tests/helpers/graphql.ts`         | Wait for a named API response and reuse an authorization header     |
| `tests/helpers/design-workflow.ts` | Repeated design upload and sharing steps                            |
| `tests/helpers/synthetic-model.ts` | Build a small STL test file                                         |
| `tests/helpers/synthetic-ct.ts`    | Generated CT test file; normally no editing is needed               |
| `playwright.config.ts`             | Application URL, browsers, timeouts, and reports                    |
| `Jenkinsfile`                      | Install dependencies, check code, run tests, and archive reports    |
| `scripts/`                         | Optional Python tools for fixtures and a historical UAT spreadsheet |

## How to read a test

Start with the `test('TC-...', async (...) => { ... })` block. Read its actions
from top to bottom. Larger scenarios use `test.step(...)` to label sections in
the report.

- `page` is a browser tab. `context` is an independent session with its own cookies.
- `await` waits for an action to finish before the next line runs.
- `getByRole(...)` finds a control by its role and visible name.
- `expect(...)` checks the result. Browser checks such as `toBeVisible()` retry while the page updates.
- `const` holds a value that is not reassigned. `let` is used when a value changes.
- A helper is an ordinary function for steps used by several tests. Open its import to see its code.
- `try` / `finally` ensures cleanup runs even when a check fails.

### Waiting for the API

GraphQL is the application's API. An operation name identifies the request,
such as `Request` or `Login`. When an action triggers a response, the test starts
listening **before** the action:

```typescript
const [response] = await Promise.all([
  waitForGraphqlResponse(page, 'Request'),
  page.goto('/partner/requests/REQ-2026-0673'),
]);
const body = await response.json();
expect(body.errors).toBeUndefined();
```

`Promise.all` waits for both the response and navigation. `[response]` takes the
first result. Keep this order: starting the wait after navigation can miss a fast
response. Some tests read `.json()` inside the wait because a later navigation
can discard the response body.

### Editing a scenario

1. Find the file with the matching test case ID.
2. Update the relevant actions and expected results. Use names that explain their purpose.
3. Keep one action per statement and use braces around `if` and loop bodies.
4. Keep checks for business rules in the test; put repeated steps in a small helper.
5. Run `npm run format`, `npm run check`, and the changed test file.

A skipped test is not a pass. Some scenarios require specific existing requests,
prices, or accounts; read their comments and annotations when investigating a failure.

## Python scripts

`python scripts/export-uat-results.py` creates `UAT-Test-Results.xlsx` from the
saved historical results in `scripts/uat-results-data.json`. It does not read the
latest Playwright run and does not update test statuses automatically.

`python scripts/generate-synthetic-ct.py` regenerates the embedded CT fixture.
It requires `pydicom==3.0.2`. The generated slices are synthetic test data.

The PDF checks in some tests have a separate dependency list in
`tests/helpers/requirements-pdf.txt`.
