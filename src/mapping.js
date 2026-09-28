// Shopify `orders/create` webhook payload -> one canonical order every adapter understands.
//
// Customer resolution: B2B buyers are matched by e-mail to their ERP customer code;
// everyone else lands on the generic web-shop customer, which is how most ERP
// installations book B2C web orders.

export function toCanonicalOrder(shopifyOrder, { customerByEmail = {}, defaultCustomer = 'WEB' } = {}) {
  const email = (shopifyOrder.customer?.email || shopifyOrder.email || '').toLowerCase();
  const lines = (shopifyOrder.line_items || [])
    .filter((l) => l.sku) // gift cards / custom items without a SKU are not ERP parts
    .map((l) => ({ sku: l.sku, qty: Number(l.quantity), unitPrice: round2(Number(l.price)) }));

  if (lines.length === 0) throw new Error(`Shopify order ${shopifyOrder.name} has no lines with a SKU`);

  return {
    reference: shopifyOrder.name, // "#1001" — stored on the ERP order, also the idempotency key
    externalId: `shopify-${shopifyOrder.id}`,
    customerCode: customerByEmail[email] || defaultCustomer,
    orderDate: (shopifyOrder.created_at || new Date().toISOString()).slice(0, 10),
    currency: shopifyOrder.currency,
    note: shopifyOrder.note || '',
    lines,
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
