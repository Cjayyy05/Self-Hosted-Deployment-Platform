import { Client } from 'pg';
import { createServer } from 'node:net';

// The host gate stays held by the actual process if PostgreSQL releases its
// advisory lock before the process detects a lost connection.
export async function acquireLinuxHostGate() {
  if (process.platform !== 'linux') return undefined;
  const gate = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    gate.once('error', reject);
    gate.listen({ path: '\0deployflow-backend-host-gate-v2', exclusive: true }, resolve);
  });
  return gate;
}

// Hold a session lock until the process exits. Serialize admission so checking
// for the opposite mode and acquiring our shared lock are one startup decision.
export const acquireBackendMode = async (connectionString: string, publicMode: boolean): Promise<Client> => {
  const client = new Client({ connectionString, keepAlive: true, keepAliveInitialDelayMillis: 1_000,
    connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
  const namespace = 0x4450464c; // DeployFlow
  const mine = publicMode ? 1 : 2;
  const other = publicMode ? 2 : 1;
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, 0)', [namespace]);
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS acquired', [namespace, other],
    );
    if (result.rows[0]?.acquired !== true) throw new Error('An incompatible DeployFlow backend mode is already running');
    await client.query('SELECT pg_advisory_lock_shared($1::int, $2::int)', [namespace, mine]);
    await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [namespace, other]);
    await client.query('COMMIT');
    return client;
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
};
