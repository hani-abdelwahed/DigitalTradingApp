import { describe, expect, it } from 'vitest';
import { SecretBox } from '../src/lib/crypto.js';

describe('SecretBox', () => {
  const box = new SecretBox(Buffer.alloc(32, 1).toString('base64'));

  it('round-trips and uses a fresh IV each time', () => {
    const a = box.encrypt('JBSWY3DPEHPK3PXP');
    const b = box.encrypt('JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(b);
    expect(box.decrypt(a)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects tampered ciphertext', () => {
    const parts = box.encrypt('secret').split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
  });

  it('rejects a different key', () => {
    const other = new SecretBox(Buffer.alloc(32, 2).toString('base64'));
    expect(() => other.decrypt(box.encrypt('secret'))).toThrow();
  });
});
