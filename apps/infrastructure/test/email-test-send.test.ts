import { renderTestEmail } from '../lambda/email-test-send';

describe('renderTestEmail', () => {
  test('prefixes the subject and resolves merge tags with sample values', () => {
    const { subject, html } = renderTestEmail(
      'Hi {{first_name}} from {{company}}',
      '<p>Hello {{firstName}} {{lastName}}</p>',
      'me@example.com',
    );
    expect(subject).toBe('[TEST] Hi Test from Acme Inc');
    expect(html).toBe('<p>Hello Test Recipient</p>');
  });

  test('falls back gracefully for empty subject/body', () => {
    const { subject, html } = renderTestEmail(null, null, 'me@example.com');
    expect(subject).toBe('[TEST] No Subject');
    expect(html).toContain('no content yet');
  });

  test('leaves unknown tags untouched (no crash)', () => {
    const { html } = renderTestEmail('s', '<p>{{unknown_tag}}</p>', 'me@example.com');
    expect(html).toBe('<p>{{unknown_tag}}</p>');
  });
});
