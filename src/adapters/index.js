import { createPriorityAdapter } from './priority.js';
import { createNetSuiteAdapter } from './netsuite.js';
import { createBusinessCentralAdapter } from './business-central.js';
import { createOdooAdapter } from './odoo.js';

export const adapters = {
  priority: createPriorityAdapter,
  netsuite: createNetSuiteAdapter,
  'business-central': createBusinessCentralAdapter,
  odoo: createOdooAdapter,
};

// Build the adapter named by ERP from environment variables (see .env.example).
export function adapterFromEnv(env = process.env) {
  switch (env.ERP) {
    case 'priority':
      return createPriorityAdapter({ baseUrl: env.PRIORITY_URL, username: env.PRIORITY_USER, password: env.PRIORITY_PASSWORD, token: env.PRIORITY_TOKEN });
    case 'netsuite':
      return createNetSuiteAdapter({ baseUrl: env.NETSUITE_URL, accessToken: env.NETSUITE_TOKEN });
    case 'business-central':
      return createBusinessCentralAdapter({ baseUrl: env.BC_URL, companyId: env.BC_COMPANY_ID, accessToken: env.BC_TOKEN });
    case 'odoo':
      return createOdooAdapter({ baseUrl: env.ODOO_URL, db: env.ODOO_DB, username: env.ODOO_USER, apiKey: env.ODOO_API_KEY });
    default:
      throw new Error(`Set ERP to one of: ${Object.keys(adapters).join(', ')}`);
  }
}
