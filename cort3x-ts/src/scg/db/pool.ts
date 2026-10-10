import { Pool } from 'pg';

/**
 * Generic PostgreSQL pool factory. Provider-neutral — knows nothing about
 * Neon, RDS, Supabase, or any other host. Consumers (persistence/,
 * orchestrator/) only ever see a pg.Pool; this is the one place that
 * resolves *how* that Pool gets its connection info.
 *
 * Precedence:
 *   1. DATABASE_URL, if set — passed straight through as connectionString.
 *      pg's own Pool constructor parses this; no manual URL parsing here.
 *   2. Discrete vars (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE), if
 *      DATABASE_URL is absent and at least PGHOST + PGDATABASE are present.
 *   3. Neither resolves -> throw immediately. Never return a Pool that
 *      would only fail later on first query.
 */
export function createPool(): Pool {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl && databaseUrl.trim().length > 0) {
    return new Pool({ connectionString: databaseUrl });
  }

  const host = process.env.PGHOST;
  const database = process.env.PGDATABASE;

  if (host && host.trim().length > 0 && database && database.trim().length > 0) {
    const port = process.env.PGPORT ? Number(process.env.PGPORT) : undefined;
    if (process.env.PGPORT && Number.isNaN(port)) {
      throw new Error(
        `Pool Factory Fault: PGPORT is set but not a valid number (got '${process.env.PGPORT}').`
      );
    }
    return new Pool({
      host,
      database,
      port,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
    });
  }

  throw new Error(
    'Pool Factory Fault: no usable PostgreSQL configuration found. ' +
      'Set DATABASE_URL, or set both PGHOST and PGDATABASE (with optional ' +
      'PGPORT/PGUSER/PGPASSWORD).'
  );
}
