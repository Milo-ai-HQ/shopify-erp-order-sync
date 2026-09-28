// One error type for every ERP, so sync.js can decide what to do without knowing which
// system answered. `retryable` is true only for failures a retry can fix.
export class ErpError extends Error {
  constructor(message, { status = 0, retryable = false, erp } = {}) {
    super(message);
    this.name = 'ErpError';
    this.status = status;
    this.retryable = retryable;
    this.erp = erp;
  }
}
