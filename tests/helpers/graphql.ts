import { Page, Response } from '@playwright/test';
import { waitForUpload } from './uploads';

// Start this wait BEFORE clicking or navigating, so a fast response is not missed.
export function waitForGraphqlResponse(page: Page, operationName: string) {
  if (operationName === 'RegisterDesignFile') return waitForDesignRegistration(page);
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

async function waitForDesignRegistration(page: Page): Promise<Response> {
  let registered: Response | undefined;
  const listener = (response: Response) => {
    if (
      response.url().endsWith('/graphql') &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON()?.operationName === 'RegisterDesignFile'
    )
      registered = response;
  };
  page.on('response', listener);
  try {
    await waitForUpload(page, async () => Boolean(registered));
    return registered!;
  } finally {
    page.off('response', listener);
  }
}

// Reuse only this response's authorization header when checking the same user's API access.
export function getAuthorizationHeaders(response: Response): Record<string, string> {
  const authorization = response.request().headers().authorization;
  if (authorization) {
    return { authorization };
  }
  return {};
}
