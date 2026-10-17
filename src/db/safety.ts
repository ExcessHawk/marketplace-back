export const DISPOSABLE_MARKER = 'marketplace:disposable';

export interface QueryRunner {
  query(text: string): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export class NotDisposableError extends Error {
  constructor(
    readonly operation: string,
    readonly database: string,
    readonly reason: string,
  ) {
    super(
      `Refusing to ${operation} on database "${database}": ${reason}\n\n` +
      'Destructive operations only run against a database explicitly marked as\n' +
      'disposable. If this really is a throwaway database, mark it once:\n\n' +
      '    bun run db:mark-disposable\n\n' +
      'If you did not expect this database, check DATABASE_URL / TEST_DATABASE_URL —\n' +
      'a tunnel to a remote server also listens on localhost, so the port alone\n' +
      'does not tell you where you are pointed.',
    );
    this.name = 'NotDisposableError';
  }
}

export function redactConnectionString(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = parsed.username || '***';
    return parsed.toString();
  } catch {
    return '<unparseable connection string>';
  }
}

export function describeTarget(url: string): { host: string; port: string; database: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: parsed.pathname.replace(/^\//, '') || '(default)',
    };
  } catch {
    return { host: '(unknown)', port: '(unknown)', database: '(unknown)' };
  }
}

export async function assertDisposableDatabase(
  runner: QueryRunner,
  operation: string,
): Promise<void> {
  const { rows } = await runner.query(
    `select current_database() as database,
            shobj_description(oid, 'pg_database') as marker
       from pg_database
      where datname = current_database()`,
  );

  const database = String(rows[0]?.database ?? '(unknown)');
  const marker = rows[0]?.marker;

  if (marker == null) {
    throw new NotDisposableError(operation, database, 'it carries no disposable marker');
  }
  if (!String(marker).includes(DISPOSABLE_MARKER)) {
    throw new NotDisposableError(
      operation,
      database,
      `its marker is ${JSON.stringify(String(marker))}, not "${DISPOSABLE_MARKER}"`,
    );
  }
}

export async function markDatabaseDisposable(runner: QueryRunner): Promise<string> {
  const { rows } = await runner.query('select current_database() as database');
  const database = String(rows[0]?.database ?? '');
  if (!database) throw new Error('Could not determine the current database');

  const quotedName = `"${database.replace(/"/g, '""')}"`;
  await runner.query(`COMMENT ON DATABASE ${quotedName} IS '${DISPOSABLE_MARKER}'`);
  return database;
}

export function requireTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.TEST_DATABASE_URL;

  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set.\n\n' +
      'The test suite drops and recreates the public schema, so it refuses to\n' +
      'reuse DATABASE_URL — that variable has pointed at a tunnel to production.\n\n' +
      'Point TEST_DATABASE_URL at a throwaway database and mark it once:\n\n' +
      '    TEST_DATABASE_URL=postgresql://user:pass@localhost:5442/marketplace_test\n' +
      '    bun run db:mark-disposable\n',
    );
  }

  if (env.DATABASE_URL && url === env.DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL is identical to DATABASE_URL.\n\n' +
      'The test suite would drop the schema of the database the application\n' +
      'itself uses. Point it at a separate throwaway database.',
    );
  }

  return url;
}
