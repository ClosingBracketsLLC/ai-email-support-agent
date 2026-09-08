import { pgRole } from 'drizzle-orm/pg-core'

/** Tenant traffic: forced RLS, sees only rows where org_id matches the transaction's app.org_id. */
export const aesaApp = pgRole('aesa_app')
/** Platform sweeps and crons: policy USING (true); reached only through withPlatform(). */
export const aesaPlatform = pgRole('aesa_platform')
