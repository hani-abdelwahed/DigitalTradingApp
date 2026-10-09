import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, stepAt, totp, verifyTotp } from '../src/auth/totp.js';

// RFC 6238 appendix B, SHA-1 key, truncated to 6 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const vectors: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

describe('totp', () => {
  it.each(vectors)('matches the RFC 6238 vector at t=%i', (t, code) => {
    expect(totp(RFC_SECRET, t * 1000)).toBe(code);
  });

  it('round-trips base32', () => {
    const buf = Buffer.from('any bytes \x00\xff here');
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });

  it('accepts one step of clock drift but not two', () => {
    const now = 1_700_000_000_000;
    const key = base32Decode(RFC_SECRET);
    const step = stepAt(now);
    expect(verifyTotp(RFC_SECRET, hotp(key, step - 1), { timeMs: now })).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, hotp(key, step + 1), { timeMs: now })).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, hotp(key, step - 2), { timeMs: now })).toBeNull();
  });

  it('rejects a code at or before the last used step', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    const code = totp(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, { timeMs: now, afterStep: step })).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, { timeMs: now, afterStep: step - 1 })).toBe(step);
  });

  it('rejects malformed codes', () => {
    expect(verifyTotp(RFC_SECRET, '12345')).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef')).toBeNull();
  });
});
