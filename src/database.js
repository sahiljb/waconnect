import pg from 'pg'

const { Pool } = pg

export function createDatabase({ connectionString, logger }) {
  if (!connectionString) throw new Error('DATABASE_URL is required')

  const pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  })

  pool.on('error', (error) => logger.error({ error }, 'Unexpected PostgreSQL pool error'))
  return pool
}

export async function migrateDatabase(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      session_id VARCHAR(64) PRIMARY KEY,
      credentials JSONB NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'disconnected',
      whatsapp_user JSONB,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth_keys (
      session_id VARCHAR(64) NOT NULL REFERENCES whatsapp_sessions(session_id) ON DELETE CASCADE,
      key_type VARCHAR(64) NOT NULL,
      key_id TEXT NOT NULL,
      key_data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, key_type, key_id)
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS whatsapp_sessions_status_idx
    ON whatsapp_sessions(status)
  `)
}
