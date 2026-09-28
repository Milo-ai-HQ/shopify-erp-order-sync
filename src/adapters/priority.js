import { requestJson } from '../http.js';

// Priority REST API (OData v4).
// Base URL: https://<server>/odata/Priority/tabula.ini/<company>
// The order goes in with its lines in one deep insert through ORDERITEMS_SUBFORM.
// BOOKNUM ("customer's order number") holds the Shopify order name for idempotency.
export function createPriorityAdapter({ baseUrl, username, password, token }) {
  const auth = token
    ? `Bearer ${token}`
    : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const call = (path, opts = {}) =>
    requestJson(`${baseUrl}${path}`, { ...opts, headers: { Authorization: auth }, erp: 'priority', extractError });

  return {
    name: 'priority',

    async findExisting(order) {
      const filter = encodeURIComponent(`BOOKNUM eq '${odataEscape(order.reference)}'`);
      const { data } = await call(`/ORDERS?$filter=${filter}&$select=ORDNAME,BOOKNUM`);
      const row = data.value?.[0];
      return row ? { id: row.ORDNAME, number: row.ORDNAME } : null;
    },

    async create(order) {
      const { data } = await call('/ORDERS', {
        method: 'POST',
        body: {
          CUSTNAME: order.customerCode,
          CURDATE: order.orderDate,
          BOOKNUM: order.reference,
          DETAILS: order.note.slice(0, 48),
          ORDERITEMS_SUBFORM: order.lines.map((l) => ({ PARTNAME: l.sku, TQUANT: l.qty, PRICE: l.unitPrice })),
        },
      });
      return { id: data.ORDNAME, number: data.ORDNAME };
    },
  };
}

// Priority returns interface errors inside a FORM envelope.
function extractError(data) {
  return data?.FORM?.InterfaceErrors?.text || data?.error?.message;
}

const odataEscape = (s) => String(s).replace(/'/g, "''");
