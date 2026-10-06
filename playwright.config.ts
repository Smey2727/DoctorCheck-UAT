import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // Location of test files
  testDir: './tests',

  // Run tests in parallel
  fullyParallel: true,

  // Fail if test.only is accidentally committed
  forbidOnly: !!process.env.CI,

  // Retry failed tests on CI/Jenkins
  retries: process.env.CI ? 2 : 0,

  // Use 2 workers on CI/Jenkins
  workers: process.env.CI ? 3 : undefined,

  // Test reporters
  reporter: process.env.CI
    ? [
        ['list'],
        ['html', { open: 'never' }],
        ['junit', { outputFile: 'test-results/junit.xml' }],
      ]
    : 'html',

  // Shared settings for all tests
  use: {
    // Deployed DoctorCheck application
    baseURL: 'https://doctorcheck.saerosoft.com',

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

    // Mozilla Firefox
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
      },
    },

    // Safari engine
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
      },
    },
  ],
});