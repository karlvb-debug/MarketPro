import { test, expect } from '@playwright/test';

// Critical-path smoke tests. The app runs in offline/local mode (no
// NEXT_PUBLIC_API_URL at build time), so these cover rendering, routing,
// hydration, and dialog behavior — not server round-trips.

test('dashboard renders after hydration', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
});

test('sidebar navigation reaches every section', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });

  await nav.getByRole('link', { name: 'Contacts' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'All Contacts' })).toBeVisible();

  await nav.getByRole('link', { name: 'Campaigns' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Campaigns' })).toBeVisible();

  await nav.getByRole('link', { name: 'Inbox' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();

  await nav.getByRole('link', { name: 'Analytics' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible();
});

test('settings page renders workspace configuration', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
});

test('import wizard opens as an accessible dialog and closes on Escape', async ({ page }) => {
  await page.goto('/contacts');
  await page.getByRole('button', { name: 'Import CSV / Excel' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Import Contacts')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('no route crashes into the error boundary', async ({ page }) => {
  for (const route of ['/', '/contacts', '/campaigns', '/templates', '/settings', '/inbox', '/analytics', '/email-builder']) {
    await page.goto(route);
    // The root error boundary renders role="alert" with a Try again button
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  }
});
