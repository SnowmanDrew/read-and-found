import { createHmac, timingSafeEqual } from 'node:crypto';

// Saving is only possible after an actual completed recommendation run.
// Proof expires after 24h. Never expose the signing key to the browser.
function digest(sessionId, data, issued, secret) {
  const signed = JSON.stringify([issued, sessionId]);
  return createHmac('sha256', secret).update('read-and-found-share-v1').update(signed).digest('hex');
}
export function issueShareProof(data, sessionId, secret) {
  if (!secret || !sessionId || data.books?.length !== 5) return '';
  const issued = Date.now().toString(36);
  return issued + '.' + digest(sessionId, data, issued, secret);
}
export function verifyShareProof(proof, data, sessionId, secret) {
  if (!secret || !sessionId || typeof proof !== 'string' || !/^[a-z0-9]{8,12}\.[a-f0-9]{64}$/.test(proof)) return false;
  const [issued,signature] = proof.split('.');
  const age = Date.now() - parseInt(issued, 36);
  if (!(age >= 0 && age <= 24 * 3600000)) return false;
  const actual = Buffer.from(signature,'hex');
  const expected = Buffer.from(digest(sessionId,data,issued,secret),'hex');
  return actual.length === expected.length && timingSafeEqual(actual,expected);
}
