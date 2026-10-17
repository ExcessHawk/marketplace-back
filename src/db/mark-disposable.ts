import { Pool } from 'pg';
import { describeTarget, markDatabaseDisposable, requireTestDatabaseUrl } from './safety';

const url = requireTestDatabaseUrl();
const target = describeTarget(url);

const pool = new Pool({ connectionString: url });

try {
  const database = await markDatabaseDisposable(pool);
  console.log(`Marked "${database}" at ${target.host}:${target.port} as disposable.`);
} finally {
  await pool.end();
}
