// In-memory stand-in for four ERP APIs: Priority REST (OData), NetSuite REST +
// SuiteQL, Business Central API v2.0 and Odoo JSON-RPC.
//
// Each route mirrors the real request/response/error shape closely enough that the
// adapters in ../src/adapters can be written against the real API contracts. Every
// ERP enforces the same credit-limit rule the native per-platform repos implement,
// with the same message, so the rejection path can be tested end to end.

import http from 'node:http';

export const CREDIT_MESSAGE = 'Order exceeds customer credit limit';

function seed() {
  return {
    customers: [
      { code: 'C1001', name: 'Acme Ltd', email: 'buyer@acme.example', creditLimit: 10000, balance: 2000, nsId: '501', odooId: 7 },
      { code: 'C1002', name: 'Blue Ocean Retail', email: 'orders@blueocean.example', creditLimit: 1000, balance: 950, nsId: '502', odooId: 8 },
      { code: 'WEB', name: 'Web shop customer', email: null, creditLimit: 0, balance: 0, nsId: '599', odooId: 9 },
    ],
    items: [
      { sku: 'SKU-100', name: 'Widget', price: 19.9, nsId: '1100', odooId: 31 },
      { sku: 'SKU-200', name: 'Gadget', price: 120, nsId: '1200', odooId: 32 },
    ],
    orders: [], // { id, number, customerCode, reference, date, lines: [{ sku, qty, price }], total, platform }
    seq: 1000,
  };
}

const orderTotal = (lines) => lines.reduce((s, l) => s + l.qty * l.price, 0);

export function createMockErp() {
  let db = seed();

  const openExposure = (code) =>
    db.orders.filter((o) => o.customerCode === code).reduce((s, o) => s + o.total, 0);

  function createOrder(platform, customerCode, reference, date, lines) {
    const customer = db.customers.find((c) => c.code === customerCode);
    if (!customer) return { error: `Customer ${customerCode} does not exist` };
    for (const l of lines) {
      if (!db.items.some((i) => i.sku === l.sku)) return { error: `Part ${l.sku} does not exist` };
    }
    const total = orderTotal(lines);
    if (customer.creditLimit > 0 && customer.balance + openExposure(customer.code) + total > customer.creditLimit) {
      return { error: CREDIT_MESSAGE };
    }
    const id = ++db.seq;
    const prefix = { priority: 'SO', netsuite: 'SO-NS', bc: 'S-ORD', odoo: 'S' }[platform];
    const order = { id, number: `${prefix}${id}`, customerCode, reference, date, lines, total, platform };
    db.orders.push(order);
    return { order };
  }

  const handlers = [
    // ---------- Priority REST: /odata/Priority/tabula.ini/<company>/ORDERS ----------
    {
      match: /^\/odata\/Priority\/tabula\.ini\/[^/]+\/ORDERS$/,
      GET(req, url) {
        const f = url.searchParams.get('$filter') || '';
        const m = f.match(/BOOKNUM eq '(.*)'/);
        const rows = db.orders
          .filter((o) => o.platform === 'priority' && (!m || o.reference === m[1]))
          .map((o) => ({ ORDNAME: o.number, CUSTNAME: o.customerCode, BOOKNUM: o.reference, TOTPRICE: o.total }));
        return [200, { value: rows }];
      },
      POST(req, url, body) {
        const lines = (body.ORDERITEMS_SUBFORM || []).map((l) => ({ sku: l.PARTNAME, qty: l.TQUANT, price: l.PRICE }));
        const r = createOrder('priority', body.CUSTNAME, body.BOOKNUM, body.CURDATE, lines);
        if (r.error) return [400, { FORM: { '@TYPE': 'ORDERS', InterfaceErrors: { text: r.error } } }];
        return [201, { ORDNAME: r.order.number, CUSTNAME: body.CUSTNAME, BOOKNUM: body.BOOKNUM, TOTPRICE: r.order.total }];
      },
    },

    // ---------- NetSuite SuiteQL: /services/rest/query/v1/suiteql ----------
    {
      match: /^\/services\/rest\/query\/v1\/suiteql$/,
      POST(req, url, body) {
        const q = String(body.q || '');
        const inList = [...q.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        if (/FROM\s+item/i.test(q)) {
          const items = db.items.filter((i) => inList.includes(i.sku)).map((i) => ({ id: i.nsId, itemid: i.sku }));
          return [200, { items, count: items.length, hasMore: false }];
        }
        if (/FROM\s+customer/i.test(q)) {
          const items = db.customers.filter((c) => inList.includes(c.code)).map((c) => ({ id: c.nsId, entityid: c.code }));
          return [200, { items, count: items.length, hasMore: false }];
        }
        return [400, nsError('Unsupported query in mock')];
      },
    },

    // ---------- NetSuite REST record: upsert by external id ----------
    {
      match: /^\/services\/rest\/record\/v1\/salesOrder\/eid:(.+)$/,
      PUT(req, url, body, [, eid]) {
        const existing = db.orders.find((o) => o.platform === 'netsuite' && o.externalId === eid);
        if (existing) return [204, null, { Location: `/services/rest/record/v1/salesOrder/${existing.id}` }];
        const customer = db.customers.find((c) => c.nsId === body.entity?.id);
        const lines = (body.item?.items || []).map((l) => ({
          sku: db.items.find((i) => i.nsId === l.item?.id)?.sku ?? `#${l.item?.id}`,
          qty: l.quantity,
          price: l.rate,
        }));
        const r = createOrder('netsuite', customer?.code ?? `#${body.entity?.id}`, body.otherRefNum, body.tranDate, lines);
        if (r.error) return [400, nsError(r.error)];
        r.order.externalId = eid;
        return [204, null, { Location: `/services/rest/record/v1/salesOrder/${r.order.id}` }];
      },
    },

    // ---------- Business Central API v2.0 ----------
    {
      match: /^\/api\/v2\.0\/companies\(([^)]+)\)\/salesOrders$/,
      GET(req, url) {
        const f = url.searchParams.get('$filter') || '';
        const m = f.match(/externalDocumentNumber eq '(.*)'/);
        const value = db.orders
          .filter((o) => o.platform === 'bc' && (!m || o.reference === m[1]))
          .map(bcOrder);
        return [200, { value }];
      },
      POST(req, url, body) {
        const lines = (body.salesOrderLines || []).map((l) => {
          if (l.lineType !== 'Item') return { sku: `(${l.lineType})`, qty: 0, price: 0 };
          return { sku: l.lineObjectNumber, qty: l.quantity, price: l.unitPrice };
        });
        const r = createOrder('bc', body.customerNumber, body.externalDocumentNumber, body.orderDate, lines);
        if (r.error) return [400, { error: { code: 'Application_DialogException', message: r.error } }];
        return [201, bcOrder(r.order)];
      },
    },

    // ---------- Odoo JSON-RPC ----------
    {
      match: /^\/jsonrpc$/,
      POST(req, url, body) {
        const { service, method, args = [] } = body.params || {};
        const reply = (result) => [200, { jsonrpc: '2.0', id: body.id, result }];
        const fail = (message) => [200, {
          jsonrpc: '2.0', id: body.id,
          error: { code: 200, message: 'Odoo Server Error', data: { name: 'odoo.exceptions.UserError', message } },
        }];
        if (service === 'common' && method === 'login') return reply(args[1] && args[2] ? 2 : false);
        if (service !== 'object' || method !== 'execute_kw') return fail('Unsupported call in mock');
        const [, uid, , model, op, opArgs = [], kw = {}] = args;
        if (!uid) return fail('Access denied');
        if (op === 'search_read') {
          const domain = opArgs[0] || [];
          const cond = Object.fromEntries(domain.map(([f, , v]) => [f, v]));
          if (model === 'res.partner') {
            return reply(db.customers.filter((c) => c.code === cond.ref).map((c) => ({ id: c.odooId, name: c.name, ref: c.code })));
          }
          if (model === 'product.product') {
            const codes = cond.default_code || [];
            return reply(db.items.filter((i) => codes.includes(i.sku)).map((i) => ({ id: i.odooId, default_code: i.sku })));
          }
          if (model === 'sale.order') {
            return reply(db.orders
              .filter((o) => o.platform === 'odoo' && o.reference === cond.client_order_ref)
              .map((o) => ({ id: o.id, name: o.number })));
          }
        }
        if (model === 'sale.order' && op === 'create') {
          const vals = opArgs[0];
          const customer = db.customers.find((c) => c.odooId === vals.partner_id);
          const lines = (vals.order_line || []).map(([, , l]) => ({
            sku: db.items.find((i) => i.odooId === l.product_id)?.sku ?? `#${l.product_id}`,
            qty: l.product_uom_qty,
            price: l.price_unit,
          }));
          const r = createOrder('odoo', customer?.code ?? `#${vals.partner_id}`, vals.client_order_ref, vals.date_order, lines);
          if (r.error) return fail(r.error);
          return reply(r.order.id);
        }
        return fail(`Unsupported ${model}.${op} in mock (kw: ${JSON.stringify(kw)})`);
      },
    },
  ];

  function bcOrder(o) {
    return { id: `00000000-0000-0000-0000-${String(o.id).padStart(12, '0')}`, number: o.number, customerNumber: o.customerCode, externalDocumentNumber: o.reference, totalAmountIncludingTax: o.total };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const route = handlers.find((h) => h.match.test(url.pathname));
    const handler = route?.[req.method];
    let status, payload, headers = {};
    try {
      if (url.pathname !== '/jsonrpc' && !req.headers.authorization) {
        [status, payload] = [401, { error: 'Missing Authorization header' }];
      } else if (!handler) {
        [status, payload] = [404, { error: `No mock route for ${req.method} ${url.pathname}` }];
      } else {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        [status, payload, headers = {}] = handler(req, url, body, url.pathname.match(route.match));
      }
    } catch (err) {
      [status, payload] = [500, { error: String(err) }];
    }
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(payload == null ? '' : JSON.stringify(payload));
  });

  return {
    server,
    get orders() { return db.orders; },
    reset() { db = seed(); },
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
    },
    close() { return new Promise((resolve) => server.close(resolve)); },
  };
}

function nsError(detail) {
  return {
    type: 'https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.1',
    title: 'Bad Request',
    status: 400,
    'o:errorDetails': [{ detail, 'o:errorCode': 'USER_ERROR' }],
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 4010);
  createMockErp().listen(port).then((base) => console.log(`Mock ERP API listening on ${base}`));
}
