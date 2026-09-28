import http from 'node:http';
import { adapterFromEnv } from './adapters/index.js';
import { toCanonicalOrder } from './mapping.js';
import { syncOrder } from './sync.js';
import { verifyShopifyHmac } from './webhook.js';

// Webhook receiver for Shopify `orders/create`.
// Answers 200 for created / duplicate / rejected (a retry would not change a business
// rejection, so Shopify must not keep resending it) and 503 for transient failures so
// Shopify's own retry schedule takes over.
export function createWebhookServer({ adapter, secret, mappingOptions, log = console }) {
  return http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/webhooks/orders-create') {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);

    if (!verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256'], secret)) {
      res.writeHead(401).end('invalid signature');
      return;
    }

    let result;
    try {
      result = await syncOrder(adapter, toCanonicalOrder(JSON.parse(raw), mappingOptions));
    } catch (err) {
      log.error('sync crashed', err);
      res.writeHead(500).end();
      return;
    }
    log.info(JSON.stringify(result));
    res.writeHead(result.status === 'failed' ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3000);
  const mappingOptions = {
    customerByEmail: JSON.parse(process.env.CUSTOMER_BY_EMAIL || '{}'),
    defaultCustomer: process.env.DEFAULT_CUSTOMER || 'WEB',
  };
  createWebhookServer({ adapter: adapterFromEnv(), secret: process.env.SHOPIFY_WEBHOOK_SECRET, mappingOptions })
    .listen(port, () => console.log(`shopify-sync (${process.env.ERP}) listening on :${port}`));
}
