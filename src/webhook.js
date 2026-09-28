import crypto from 'node:crypto';

// Shopify signs every webhook: base64(HMAC-SHA256(raw body, app secret)) in
// X-Shopify-Hmac-Sha256. Must be checked against the raw bytes, before JSON parsing.
export function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(hmacHeader, 'base64');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
