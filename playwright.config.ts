import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  // Location of test files
  testDir: './tests',

  // Run tests in parallel
  fullyParallel: true,

  // Fail if test.only is accidentally committed
  forbidOnly: !!process.env.CI,

  // Retry failed tests on CI
  retries: process.env.CI ? 2 : 0,

  // Use 2 workers on CI/Jenkins
  workers: process.env.CI ? 2 : undefined,

  // Jenkins reads JUnit results; retain the HTML report for investigation
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

    // Run browser without opening it
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
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});