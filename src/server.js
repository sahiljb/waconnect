import crypto from 'node:crypto'
import express from 'express'
import pino from 'pino'
import { createDatabase, migrateDatabase } from './database.js'
import { SessionManager } from './session-manager.js'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'
const API_KEY = process.env.API_KEY
const ALLOW_INSECURE = process.env.ALLOW_INSECURE === 'true'
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

if (!API_KEY && !ALLOW_INSECURE) {
  logger.fatal('API_KEY is required. Set ALLOW_INSECURE=true only for local development.')
  process.exit(1)
}

const pool = createDatabase({ connectionString: process.env.DATABASE_URL, logger })
await migrateDatabase(pool)

const manager = new SessionManager({
  pool,
  logger: logger.child({ component: 'baileys' })
})
await manager.initialize()

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '256kb' }))

app.get('/health', async (_request, response) => {
  try {
    await pool.query('SELECT 1')
    response.json({ ok: true, database: 'connected', uptime: process.uptime() })
  } catch (error) {
    logger.error({ error }, 'Health check database query failed')
    response.status(503).json({ ok: false, database: 'disconnected' })
  }
})

app.use('/v1', (request, response, next) => {
  if (ALLOW_INSECURE && !API_KEY) return next()
  const supplied = request.get('x-api-key') ?? ''
  const expected = API_KEY ?? ''
  const valid = supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  if (!valid) return response.status(401).json({ error: 'Unauthorized' })
  next()
})

app.get('/v1/sessions', (_request, response) => {
  response.json({ sessions: manager.list() })
})

app.post('/v1/sessions', async (request, response, next) => {
  try {
    const session = await manager.connect(request.body?.sessionId)
    response.status(202).json(manager.serialize(session))
  } catch (error) { next(error) }
})

app.get('/v1/sessions/:sessionId', (request, response, next) => {
  try {
    const session = manager.get(request.params.sessionId)
    if (!session) return response.status(404).json({ error: 'Session not found' })
    response.json(manager.serialize(session))
  } catch (error) { next(error) }
})

app.get('/v1/sessions/:sessionId/qr', (request, response, next) => {
  try {
    const session = manager.get(request.params.sessionId)
    if (!session) return response.status(404).json({ error: 'Session not found' })
    if (!session.qr) return response.status(409).json({ error: 'No QR code is currently available', status: session.status })
    response.set('Cache-Control', 'no-store').json({ sessionId: session.id, qr: session.qr })
  } catch (error) { next(error) }
})

app.post('/v1/sessions/:sessionId/pairing-code', async (request, response, next) => {
  try {
    const code = await manager.requestPairingCode(request.params.sessionId, request.body?.phoneNumber)
    response.set('Cache-Control', 'no-store').json({ sessionId: request.params.sessionId, pairingCode: code })
  } catch (error) { next(error) }
})

app.post('/v1/sessions/:sessionId/reconnect', async (request, response, next) => {
  try {
    const existing = manager.get(request.params.sessionId)
    if (!existing) return response.status(404).json({ error: 'Session not found' })
    existing.status = 'disconnected'
    const session = await manager.connect(request.params.sessionId)
    response.status(202).json(manager.serialize(session))
  } catch (error) { next(error) }
})

app.post('/v1/sessions/:sessionId/messages', async (request, response, next) => {
  try {
    const result = await manager.sendMessage(
      request.params.sessionId,
      request.body?.to,
      request.body?.content,
      request.body?.options
    )
    response.status(201).json(result)
  } catch (error) { next(error) }
})

app.get('/v1/sessions/:sessionId/contacts', (request, response, next) => {
  try {
    const contacts = manager.getContacts(request.params.sessionId)
    response.set('Cache-Control', 'no-store').json({ sessionId: request.params.sessionId, contacts })
  } catch (error) { next(error) }
})

app.delete('/v1/sessions/:sessionId', async (request, response, next) => {
  try {
    const removed = await manager.remove(request.params.sessionId, { logout: request.query.logout !== 'false' })
    if (!removed) return response.status(404).json({ error: 'Session not found' })
    response.status(204).end()
  } catch (error) { next(error) }
})

app.use((error, _request, response, _next) => {
  const status = Number(error.statusCode) || 500
  if (status >= 500) logger.error({ error }, 'Request failed')
  response.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message })
})

const server = app.listen(PORT, HOST, () => {
  logger.info({ host: HOST, port: PORT, sessions: manager.list().length }, 'WhatsApp connection API listening')
})

async function shutdown(signal) {
  logger.info({ signal }, 'Shutting down')
  server.close()
  await manager.shutdown()
  await pool.end()
  process.exit(0)
}

process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
