import { StringDecoder } from 'node:string_decoder';

export function createSecretRedactor(secret) {
  if (!secret) {
    return { push: (chunk) => chunk, finish: () => '' };
  }
  const decoder = new StringDecoder('utf8');
  let carry = '';
  const redact = (contents, final) => {
    const combined = carry + contents;
    const safeEnd = final ? combined.length : Math.max(0, combined.length - secret.length + 1);
    const pieces = [];
    let cursor = 0;
    while (cursor < safeEnd) {
      const found = combined.indexOf(secret, cursor);
      if (found === -1 || found >= safeEnd) {
        pieces.push(combined.slice(cursor, safeEnd));
        cursor = safeEnd;
        break;
      }
      pieces.push(combined.slice(cursor, found), '[REDACTED]');
      cursor = found + secret.length;
    }
    carry = combined.slice(cursor);
    if (final && carry) {
      pieces.push(carry.split(secret).join('[REDACTED]'));
      carry = '';
    }
    return pieces.join('');
  };
  return {
    push: (chunk) => redact(decoder.write(chunk), false),
    finish: () => redact(decoder.end(), true),
  };
}
