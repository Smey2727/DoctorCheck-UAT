import { defineConfig, devices } from '@playwright/test';

const isCI = Boolean(process.env.CI);

export default defineConfig({
  // Location of test files
  testDir: './tests',

  // UAT cases mutate shared accounts, catalog entries, and pricing.
  fullyParallel: false,

  // Fail if test.only is accidentally committed
  forbidOnly: isCI,

  // Retry failed tests on CI/Jenkins
  retries: isCI ? 2 : 0,

  // Keep shared fixtures stable across local and Jenkins runs.
  workers: 1,

  // Test reporters
  reporter: isCI
    ? [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/junit.xml' }]]
    : 'html',

  // Shared settings for all tests
  use: {
    // Set BASE_URL to test a staging deployment instead of the default site.
    baseURL: process.env.BASE_URL || 'https://doctorcheck.saerosoft.com',

    // Run browsers without opening them
    headless: true,

    // Capture trace when a test is retried
    trace: 'on-first-retry',

    // Take screenshot when test fails
    screenshot: 'only-on-failure',

    // Keep video when test fails
    video: 'retain-on-failure',
  },

  // Browser configuration
  projects: [
    // Google Chrome / Microsoft Edge engine
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
