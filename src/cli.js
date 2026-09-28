// Sync one saved Shopify order JSON by hand:  ERP=priority node src/cli.js samples/order-b2b.json
import { readFile } from 'node:fs/promises';
import { adapterFromEnv } from './adapters/index.js';
import { toCanonicalOrder } from './mapping.js';
import { syncOrder } from './sync.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: ERP=<priority|netsuite|business-central|odoo> node src/cli.js <shopify-order.json>');
  process.exit(2);
}
const order = toCanonicalOrder(JSON.parse(await readFile(file, 'utf8')), {
  customerByEmail: JSON.parse(process.env.CUSTOMER_BY_EMAIL || '{}'),
});
const result = await syncOrder(adapterFromEnv(), order);
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === 'created' || result.status === 'duplicate' ? 0 : 1);
