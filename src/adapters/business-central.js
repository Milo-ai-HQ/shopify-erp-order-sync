import { requestJson } from '../http.js';

// Dynamics 365 Business Central API v2.0.
// Base URL: https://api.businesscentral.dynamics.com/v2.0/<tenant>/<environment>
// The sales order and its lines are created in one deep insert. The Shopify order
// name goes into externalDocumentNumber, which is also the duplicate check.
export function createBusinessCentralAdapter({ baseUrl, companyId, accessToken }) {
  const root = `${baseUrl}/api/v2.0/companies(${companyId})`;
  const call = (path, opts = {}) =>
    requestJson(`${root}${path}`, { ...opts, headers: { Authorization: `Bearer ${accessToken}` }, erp: 'business-central', extractError });

  return {
    name: 'business-central',

    async findExisting(order) {
      const filter = encodeURIComponent(`externalDocumentNumber eq '${order.reference.replace(/'/g, "''")}'`);
      const { data } = await call(`/salesOrders?$filter=${filter}&$select=id,number`);
      const row = data.value?.[0];
      return row ? { id: row.id, number: row.number } : null;
    },

    async create(order) {
      const { data } = await call('/salesOrders', {
        method: 'POST',
        body: {
          customerNumber: order.customerCode,
          externalDocumentNumber: order.reference,
          orderDate: order.orderDate,
          salesOrderLines: order.lines.map((l) => ({
            lineType: 'Item',
            lineObjectNumber: l.sku,
            quantity: l.qty,
            unitPrice: l.unitPrice,
          })),
        },
      });
      return { id: data.id, number: data.number };
    },
  };
}

function extractError(data) {
  return data?.error?.message;
}
