import { ErpError } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// JSON over HTTP with retry on network errors, 429 and 5xx (exponential backoff).
// 4xx business errors are not retried: they are handed back with the ERP's own message.
export async function requestJson(url, { method = 'GET', headers = {}, body, erp, extractError, retries = 3, backoffMs = 300 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt < retries) { await sleep(backoffMs * 2 ** attempt); continue; }
      throw new ErpError(`Network error calling ${erp}: ${err.message}`, { retryable: true, erp });
    }

    const text = await res.text();
    const data = text ? safeJson(text) : null;

    if (res.ok) return { status: res.status, headers: res.headers, data };

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) { await sleep(backoffMs * 2 ** attempt); continue; }
    const message = (data && extractError?.(data)) || `${erp} returned HTTP ${res.status}`;
    throw new ErpError(message, { status: res.status, retryable, erp });
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
