import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMockErp, CREDIT_MESSAGE } from '../mock-erp-api/server.js';
import { adapters } from '../src/adapters/index.js';
import { toCanonicalOrder } from '../src/mapping.js';
import { syncOrder } from '../src/sync.js';
import { verifyShopifyHmac } from '../src/webhook.js';
import { createWebhookServer } from '../src/server.js';

const sample = async (name) => JSON.parse(await readFile(new URL(`../samples/${name}`, import.meta.url), 'utf8'));
const mapping = { customerByEmail: { 'buyer@acme.example': 'C1001', 'orders@blueocean.example': 'C1002' } };

const mock = createMockErp();
let base;
before(async () => { base = await mock.listen(); });
after(() => mock.close());
beforeEach(() => mock.reset());

const configs = () => ({
  priority: { baseUrl: `${base}/odata/Priority/tabula.ini/demo`, username: 'api', password: 'secret' },
  netsuite: { baseUrl: base, accessToken: 'token' },
  'business-central': { baseUrl: base, companyId: 'c0ffee00-0000-0000-0000-000000000001', accessToken: 'token' },
  odoo: { baseUrl: base, db: 'demo', username: 'api', apiKey: 'key' },
});

describe('mapping', () => {
  test('maps a B2B Shopify order and drops lines without a SKU', async () => {
    const order = toCanonicalOrder(await sample('order-b2b.json'), mapping);
    assert.equal(order.customerCode, 'C1001');
    assert.equal(order.reference, '#1001');
    assert.equal(order.orderDate, '2026-09-20');
    assert.deepEqual(order.lines, [
      { sku: 'SKU-100', qty: 10, unitPrice: 19.9 },
      { sku: 'SKU-200', qty: 2, unitPrice: 120 },
    ]);
  });

  test('unknown buyers fall back to the web-shop customer', async () => {
    const shopify = { ...(await sample('order-b2b.json')), email: 'someone@else.example', customer: null };
    assert.equal(toCanonicalOrder(shopify, mapping).customerCode, 'WEB');
  });
});

describe('webhook signature', () => {
  test('accepts a correctly signed body and rejects a tampered one', () => {
    const body = Buffer.from('{"id":1}');
    const hmac = crypto.createHmac('sha256', 's3cret').update(body).digest('base64');
    assert.equal(verifyShopifyHmac(body, hmac, 's3cret'), true);
    assert.equal(verifyShopifyHmac(Buffer.from('{"id":2}'), hmac, 's3cret'), false);
    assert.equal(verifyShopifyHmac(body, undefined, 's3cret'), false);
  });
});

for (const erp of Object.keys(adapters)) {
  describe(`${erp} adapter`, () => {
    const adapter = () => adapters[erp](configs()[erp]);

    test('creates the order with all lines', async () => {
      const result = await syncOrder(adapter(), toCanonicalOrder(await sample('order-b2b.json'), mapping));
      assert.equal(result.status, 'created', result.message);
      assert.ok(result.erpOrder.number);
      assert.equal(mock.orders.length, 1);
      assert.equal(mock.orders[0].customerCode, 'C1001');
      assert.equal(mock.orders[0].reference, '#1001');
      assert.equal(mock.orders[0].total, 10 * 19.9 + 2 * 120);
    });

    test('is idempotent when Shopify resends the webhook', async () => {
      const order = toCanonicalOrder(await sample('order-b2b.json'), mapping);
      await syncOrder(adapter(), order);
      const second = await syncOrder(adapter(), order);
      assert.ok(['duplicate', 'created'].includes(second.status));
      assert.equal(mock.orders.length, 1);
    });

    test('reports the ERP credit-limit rejection instead of crashing', async () => {
      const result = await syncOrder(adapter(), toCanonicalOrder(await sample('order-over-credit.json'), mapping));
      assert.equal(result.status, 'rejected');
      assert.equal(result.message, CREDIT_MESSAGE);
      assert.equal(mock.orders.length, 0);
    });

    test('rejects an unknown part', async () => {
      const shopify = await sample('order-b2b.json');
      shopify.line_items = [{ sku: 'NOPE-1', quantity: 1, price: '1.00' }];
      const result = await syncOrder(adapter(), toCanonicalOrder(shopify, mapping));
      assert.equal(result.status, 'rejected');
      assert.match(result.message, /NOPE-1/);
    });
  });
}

describe('webhook server', () => {
  test('signed orders/create webhook ends up as an ERP order', async () => {
    const server = createWebhookServer({
      adapter: adapters.priority(configs().priority),
      secret: 's3cret',
      mappingOptions: mapping,
      log: { info() {}, error() {} },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/webhooks/orders-create`;
    const body = JSON.stringify(await sample('order-b2b.json'));
    const hmac = crypto.createHmac('sha256', 's3cret').update(body).digest('base64');

    const bad = await fetch(url, { method: 'POST', body, headers: { 'X-Shopify-Hmac-Sha256': 'AAAA' } });
    assert.equal(bad.status, 401);

    const ok = await fetch(url, { method: 'POST', body, headers: { 'X-Shopify-Hmac-Sha256': hmac } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).status, 'created');
    assert.equal(mock.orders.length, 1);
    server.close();
  });
});
