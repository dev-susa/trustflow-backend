import { getCorsOrigin } from './cors.util';

describe('getCorsOrigin', () => {
  it('rejects missing and wildcard origins in production', () => {
    expect(() => getCorsOrigin('production', undefined)).toThrow();
    expect(() => getCorsOrigin('production', '*')).toThrow();
  });

  it('parses an explicit production allowlist', () => {
    expect(getCorsOrigin('production', 'https://app.example, https://admin.example')).toEqual([
      'https://app.example',
      'https://admin.example',
    ]);
  });

  it('keeps the development fallback', () => {
    expect(getCorsOrigin('development', undefined)).toBe('*');
  });
});
