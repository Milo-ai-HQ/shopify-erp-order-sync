import { ErpError } from '../errors.js';
import { requestJson } from '../http.js';

// Odoo external API over JSON-RPC (/jsonrpc), works on Odoo 16–18.
// Logs in once, then: partner by `ref`, products by `default_code`, duplicate check on
// client_order_ref, and sale.order create with one2many order lines.
export function createOdooAdapter({ baseUrl, db, username, apiKey }) {
  let uid = null;
  let id = 0;

  async function rpc(service, method, args) {
    const { data } = await requestJson(`${baseUrl}/jsonrpc`, {
      method: 'POST',
      body: { jsonrpc: '2.0', method: 'call', id: ++id, params: { service, method, args } },
      erp: 'odoo',
    });
    // JSON-RPC reports business errors with HTTP 200 and an `error` member.
    if (data.error) throw new ErpError(data.error.data?.message || data.error.message, { erp: 'odoo' });
    return data.result;
  }

  async function execute(model, method, args, kwargs = {}) {
    if (!uid) {
      uid = await rpc('common', 'login', [db, username, apiKey]);
      if (!uid) throw new ErpError('Odoo login failed', { status: 401, erp: 'odoo' });
    }
    return rpc('object', 'execute_kw', [db, uid, apiKey, model, method, args, kwargs]);
  }

  return {
    name: 'odoo',

    async findExisting(order) {
      const rows = await execute('sale.order', 'search_read', [[['client_order_ref', '=', order.reference]]], { fields: ['name'], limit: 1 });
      return rows[0] ? { id: rows[0].id, number: rows[0].name } : null;
    },

    async create(order) {
      const [partner] = await execute('res.partner', 'search_read', [[['ref', '=', order.customerCode]]], { fields: ['id'], limit: 1 });
      if (!partner) throw new ErpError(`Customer ${order.customerCode} not found in Odoo`, { status: 404, erp: 'odoo' });

      const products = await execute('product.product', 'search_read',
        [[['default_code', 'in', order.lines.map((l) => l.sku)]]], { fields: ['id', 'default_code'] });
      const productId = Object.fromEntries(products.map((p) => [p.default_code, p.id]));
      const missing = order.lines.filter((l) => !productId[l.sku]).map((l) => l.sku);
      if (missing.length) throw new ErpError(`Products not found in Odoo: ${missing.join(', ')}`, { status: 404, erp: 'odoo' });

      const newId = await execute('sale.order', 'create', [{
        partner_id: partner.id,
        client_order_ref: order.reference,
        date_order: `${order.orderDate} 00:00:00`,
        note: order.note,
        // (0, 0, vals) = "create this line"
        order_line: order.lines.map((l) => [0, 0, { product_id: productId[l.sku], product_uom_qty: l.qty, price_unit: l.unitPrice }]),
      }]);
      const [created] = await execute('sale.order', 'search_read', [[['client_order_ref', '=', order.reference]]], { fields: ['name'], limit: 1 });
      return { id: newId, number: created?.name ?? String(newId) };
    },
  };
}
