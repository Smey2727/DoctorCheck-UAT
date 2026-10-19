import { Page, Response } from '@playwright/test';

// Start this wait BEFORE clicking or navigating, so a fast response is not missed.
export function waitForGraphqlResponse(page: Page, operationName: string) {
  return page.waitForResponse((response) => {
    if (!response.url().endsWith('/graphql')) {
      return false;
    }

    const request = response.request();
    if (request.method() !== 'POST') {
      return false;
    }

    const body = request.postDataJSON();
    return body?.operationName === operationName;
  });
}

// Reuse only this response's authorization header when checking the same user's API access.
export function getAuthorizationHeaders(response: Response): Record<string, string> {
  const authorization = response.request().headers().authorization;
  if (authorization) {
    return { authorization };
  }
  return {};
}
