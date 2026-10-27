import { expect, Page } from '@playwright/test';
import { waitForGraphqlResponse } from './graphql';
import { syntheticModel } from './synthetic-model';
import { waitForUpload } from './uploads';

// Read the current status beside the request heading, not the history list.
export function requestStatus(page: Page, requestId: string, name: string) {
  return page
    .getByRole('heading', { name: requestId, exact: true })
    .locator('..')
    .getByRole('button', { name, exact: true });
}

// Set showModel to true to open the 3D model tab instead of the counselor summary.
export async function openCounselorRequest(page: Page, requestId: string, showModel = false) {
  let requestPath = `/counselor/requests/${requestId}`;
  if (showModel) {
    requestPath = `/requests/${requestId}/model`;
  }
  const [response] = await Promise.all([
    page.waitForResponse(async (response) => {
      if (!response.url().endsWith('/graphql')) {
        return false;
      }
      const body = await response.json().catch(() => null);
      return body?.data?.request?.details?.requestNo === requestId;
    }),
    page.goto(requestPath),
  ]);
  const body = await response.json();
  return body.data.request;
}

export async function uploadDesign(
  page: Page,
  requestId: string,
  caseCode: string,
  version: number,
  size: number,
) {
  await page.getByRole('button', { name: 'Upload design result', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload design result', exact: true });
  await dialog.getByRole('spinbutton', { name: 'Width (mm)*', exact: true }).fill(String(size));
  await dialog.getByRole('spinbutton', { name: 'Height (mm)*', exact: true }).fill(String(size));
  await dialog.getByRole('spinbutton', { name: 'Thickness (mm)*', exact: true }).fill(String(size));
  const designName = `${caseCode}-design-v${version}.stl`;
  await dialog.locator('input[type="file"]').setInputFiles(syntheticModel(designName, size));
  await waitForUpload(page, () =>
    dialog.getByRole('button', { name: 'Upload design result', exact: true }).isEnabled(),
  );
  const [response] = await Promise.all([
    waitForGraphqlResponse(page, 'RegisterDesignFile'),
    dialog.getByRole('button', { name: 'Upload design result', exact: true }).click(),
  ]);
  const body = await response.json();
  expect(body.errors).toBeUndefined();
  let expectedStatus = 'REVISION_REQUESTED';
  if (version === 1) {
    expectedStatus = 'PRODUCT_DESIGN';
  }
  expect(body.data.registerDesignFile).toMatchObject({
    requestNo: requestId,
    status: expectedStatus,
  });
  await expect(dialog).toBeHidden();
}

export async function shareDesign(
  page: Page,
  requestId: string,
  caseCode: string,
  version: number,
) {
  // The server builds the preview in the background; retry until it is ready.
  await expect(async () => {
    await openCounselorRequest(page, requestId, true);
    await expect(
      page.getByRole('button', { name: `Review and share v${version}`, exact: true }),
    ).toBeEnabled({ timeout: 1000 });
  }).toPass({ timeout: 60_000, intervals: [1000, 2000, 5000] });
  await page.getByRole('button', { name: `Review and share v${version}`, exact: true }).click();
  const generate = page.getByRole('dialog', { name: 'Generate design document', exact: true });
  await generate
    .getByRole('textbox', { name: 'Counselor review note for partner', exact: true })
    .fill(`${caseCode}: Please review synthetic design revision ${version}.`);
  await generate.getByRole('button', { name: 'Generate and preview', exact: true }).click();
  await expect(generate).toBeHidden();
  const preview = page.getByRole('dialog', {
    name: 'Design-Result Document print view',
    exact: true,
  });
  await expect(preview).toContainText(`${caseCode}-design-v${version}.stl`);
  await preview.getByRole('checkbox', { name: /^I reviewed this exact document/ }).check();
  await preview.getByRole('button', { name: 'Share design with partner', exact: true }).click();
  await expect(preview).toBeHidden();
  const request = await openCounselorRequest(page, requestId);
  expect(request.details.status).toBe('REVIEW_REQUESTED');
  await expect(requestStatus(page, requestId, 'Review requested')).toBeVisible();
}

export async function getDesignVersions(page: Page, requestId: string) {
  const [body] = await Promise.all([
    waitForGraphqlResponse(page, 'DesignFiles').then((response) => response.json()),
    openCounselorRequest(page, requestId, true),
  ]);
  expect(body.errors).toBeUndefined();
  return body.data.designFiles.filter(
    (file: { category: string }) => file.category === 'DESIGN_RESULT',
  );
}

// Compare saved content and identity; the latest flag changes after a new upload.
export function getRevisionSnapshot(file: any) {
  return {
    id: file.id,
    version: file.version,
    category: file.category,
    createdAt: file.createdAt,
    uploadedByUserId: file.uploadedByUserId,
    file: {
      id: file.file.id,
      originalName: file.file.originalName,
      sizeBytes: file.file.sizeBytes,
      objectKey: file.file.objectKey,
    },
    specification: file.specification,
  };
}
