import { ErpError } from '../errors.js';
import { requestJson } from '../http.js';

// NetSuite REST Web Services.
// Base URL: https://<accountId>.suitetalk.api.netsuite.com
// Internal ids for the customer and items are resolved with one SuiteQL query each,
// then the order is upserted by external id (PUT .../salesOrder/eid:<id>): NetSuite
// itself guarantees idempotency, so findExisting has nothing to do.
export function createNetSuiteAdapter({ baseUrl, accessToken }) {
  const call = (path, opts = {}) =>
    requestJson(`${baseUrl}${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'transient' },
      erp: 'netsuite',
      extractError,
    });

  const suiteql = async (q) => (await call('/services/rest/query/v1/suiteql', { method: 'POST', body: { q } })).data.items;
  const inList = (values) => values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ');

  return {
    name: 'netsuite',

    async findExisting() {
      return null; // handled by the external-id upsert
    },

    async create(order) {
      const [customer] = await suiteql(`SELECT id, entityid FROM customer WHERE entityid IN (${inList([order.customerCode])})`);
      const items = await suiteql(`SELECT id, itemid FROM item WHERE itemid IN (${inList(order.lines.map((l) => l.sku))})`);
      const itemId = Object.fromEntries(items.map((i) => [i.itemid, i.id]));
      const missing = order.lines.filter((l) => !itemId[l.sku]).map((l) => l.sku);
      if (!customer) throw notFound(`Customer ${order.customerCode} not found in NetSuite`);
      if (missing.length) throw notFound(`Items not found in NetSuite: ${missing.join(', ')}`);

      const { headers } = await call(`/services/rest/record/v1/salesOrder/eid:${order.externalId}`, {
        method: 'PUT',
        body: {
          entity: { id: customer.id },
          tranDate: order.orderDate,
          otherRefNum: order.reference,
          memo: order.note,
          item: { items: order.lines.map((l) => ({ item: { id: itemId[l.sku] }, quantity: l.qty, rate: l.unitPrice })) },
        },
      });
      // 204 No Content — the new record's id is in the Location header.
      const id = headers.get('location')?.split('/').pop();
      return { id, number: id };
    },
  };
}

function extractError(data) {
  return data?.['o:errorDetails']?.[0]?.detail || data?.title;
}

function notFound(message) {
  return new ErpError(message, { status: 404, erp: 'netsuite' });
}
