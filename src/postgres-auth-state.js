import { BufferJSON, initAuthCreds, proto } from 'baileys'

const serialize = (value) => JSON.parse(JSON.stringify(value, BufferJSON.replacer))
const deserialize = (value) => JSON.parse(JSON.stringify(value), BufferJSON.reviver)

export async function usePostgresAuthState(pool, sessionId) {
  const result = await pool.query(
    'SELECT credentials FROM whatsapp_sessions WHERE session_id = $1',
    [sessionId]
  )

  const creds = result.rowCount
    ? deserialize(result.rows[0].credentials)
    : initAuthCreds()

  if (!result.rowCount) {
    await pool.query(
      `INSERT INTO whatsapp_sessions (session_id, credentials)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, JSON.stringify(serialize(creds))]
    )
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          if (ids.length === 0) return {}
          const keys = await pool.query(
            `SELECT key_id, key_data
             FROM whatsapp_auth_keys
             WHERE session_id = $1 AND key_type = $2 AND key_id = ANY($3::text[])`,
            [sessionId, type, ids]
          )
          const data = {}
          for (const row of keys.rows) {
            let value = deserialize(row.key_data)
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value)
            }
            data[row.key_id] = value
          }
          return data
        },
        set: async (data) => {
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            for (const [type, records] of Object.entries(data)) {
              for (const [id, value] of Object.entries(records)) {
                if (value == null) {
                  await client.query(
                    `DELETE FROM whatsapp_auth_keys
                     WHERE session_id = $1 AND key_type = $2 AND key_id = $3`,
                    [sessionId, type, id]
                  )
                } else {
                  await client.query(
                    `INSERT INTO whatsapp_auth_keys (session_id, key_type, key_id, key_data)
                     VALUES ($1, $2, $3, $4::jsonb)
                     ON CONFLICT (session_id, key_type, key_id) DO UPDATE
                     SET key_data = EXCLUDED.key_data, updated_at = NOW()`,
                    [sessionId, type, id, JSON.stringify(serialize(value))]
                  )
                }
              }
            }
            await client.query('COMMIT')
          } catch (error) {
            await client.query('ROLLBACK')
            throw error
          } finally {
            client.release()
          }
        },
        clear: async () => {
          await pool.query('DELETE FROM whatsapp_auth_keys WHERE session_id = $1', [sessionId])
        }
      }
    },
    saveCreds: async () => {
      await pool.query(
        `UPDATE whatsapp_sessions
         SET credentials = $2::jsonb, updated_at = NOW()
         WHERE session_id = $1`,
        [sessionId, JSON.stringify(serialize(creds))]
      )
    }
  }
}
