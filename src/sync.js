import { ErpError } from './errors.js';

// Create the ERP order unless it already exists. Shopify retries webhooks, so the
// same order can arrive more than once; the ERP-side lookup by reference makes the
// sync idempotent.
//
// Result status:
//   created   — new ERP order
//   duplicate — already in the ERP, nothing done
//   rejected  — the ERP refused it (credit limit, unknown part...) → needs a human
//   failed    — transient failure after retries → safe to retry later
export async function syncOrder(adapter, order) {
  try {
    const existing = await adapter.findExisting(order);
    if (existing) return { status: 'duplicate', erp: adapter.name, erpOrder: existing, reference: order.reference };
    const erpOrder = await adapter.create(order);
    return { status: 'created', erp: adapter.name, erpOrder, reference: order.reference };
  } catch (err) {
    if (!(err instanceof ErpError)) throw err;
    return {
      status: err.retryable ? 'failed' : 'rejected',
      erp: adapter.name,
      reference: order.reference,
      message: err.message,
    };
  }
}
