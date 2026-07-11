import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore
} from 'baileys'
import { usePostgresAuthState } from './postgres-auth-state.js'

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

const publicUser = (user) => user ? {
  id: user.id,
  name: user.name ?? null
} : null

const disconnectCode = (error) =>
  error?.output?.statusCode ?? error?.statusCode ?? error?.data?.statusCode ?? null

export class SessionManager {
  constructor({ pool, logger }) {
    this.pool = pool
    this.logger = logger
    this.sessions = new Map()
    this.pending = new Map()
    this.shuttingDown = false
  }

  validateId(id) {
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) {
      const error = new Error('sessionId must be 1-64 characters: letters, numbers, underscore or hyphen')
      error.statusCode = 400
      throw error
    }
    return id
  }

  async initialize() {
    const result = await this.pool.query('SELECT session_id FROM whatsapp_sessions ORDER BY created_at')
    const restored = await Promise.allSettled(result.rows.map((row) => this.connect(row.session_id)))
    for (const outcome of restored) {
      if (outcome.status === 'rejected') this.logger.error({ error: outcome.reason }, 'Session restore failed')
    }
  }

  list() {
    return [...this.sessions.values()].map((session) => this.serialize(session))
  }

  get(id) {
    this.validateId(id)
    return this.sessions.get(id) ?? null
  }

  serialize(session) {
    return {
      sessionId: session.id,
      status: session.status,
      user: publicUser(session.socket?.user),
      qrAvailable: Boolean(session.qr),
      lastError: session.lastError,
      updatedAt: session.updatedAt
    }
  }

  async connect(id) {
    this.validateId(id)
    if (this.pending.has(id)) return this.pending.get(id)

    const existing = this.sessions.get(id)
    if (existing && ['connecting', 'connected'].includes(existing.status)) return existing

    const operation = this.#openSocket(id).finally(() => this.pending.delete(id))
    this.pending.set(id, operation)
    return operation
  }

  async #openSocket(id) {
    if (this.shuttingDown) throw new Error('Service is shutting down')

    const previous = this.sessions.get(id)
    previous?.socket?.ev?.removeAllListeners()
    previous?.socket?.ws?.close()

    const { state, saveCreds } = await usePostgresAuthState(this.pool, id)
    const session = {
      id,
      socket: null,
      status: 'connecting',
      qr: null,
      lastError: null,
      reconnectTimer: null,
      generation: (previous?.generation ?? 0) + 1,
      updatedAt: new Date().toISOString()
    }
    this.sessions.set(id, session)
    this.#persistStatus(session)

    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger)
      },
      browser: Browsers.ubuntu('Chrome'),
      logger: this.logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    })
    session.socket = socket
    const generation = session.generation

    socket.ev.on('creds.update', () => {
      saveCreds().catch((error) => this.logger.error({ error, sessionId: id }, 'Could not persist credentials'))
    })
    socket.ev.on('connection.update', (update) => {
      if (this.sessions.get(id)?.generation !== generation) return
      this.#handleConnectionUpdate(session, update)
    })

    return session
  }

  #handleConnectionUpdate(session, update) {
    session.updatedAt = new Date().toISOString()

    if (update.qr) {
      session.qr = update.qr
      session.status = 'waiting_for_qr_scan'
      this.#persistStatus(session)
    }

    if (update.connection === 'open') {
      session.status = 'connected'
      session.qr = null
      session.lastError = null
      this.logger.info({ sessionId: session.id, user: publicUser(session.socket.user) }, 'WhatsApp connected')
      this.#persistStatus(session)
      return
    }

    if (update.connection !== 'close') return

    const code = disconnectCode(update.lastDisconnect?.error)
    session.qr = null
    session.lastError = update.lastDisconnect?.error?.message ?? 'Connection closed'

    if (code === DisconnectReason.loggedOut) {
      session.status = 'logged_out'
      this.logger.warn({ sessionId: session.id }, 'WhatsApp session logged out')
      this.#persistStatus(session)
      return
    }

    session.status = 'reconnecting'
    this.#persistStatus(session)
    clearTimeout(session.reconnectTimer)
    session.reconnectTimer = setTimeout(() => {
      if (!this.shuttingDown && this.sessions.get(session.id) === session) {
        this.connect(session.id).catch((error) => {
          this.logger.error({ error, sessionId: session.id }, 'Reconnect failed')
        })
      }
    }, 3000)
  }

  #persistStatus(session) {
    this.pool.query(
      `UPDATE whatsapp_sessions
       SET status = $2, whatsapp_user = $3::jsonb, last_error = $4, updated_at = NOW()
       WHERE session_id = $1`,
      [session.id, session.status, JSON.stringify(publicUser(session.socket?.user)), session.lastError]
    ).catch((error) => this.logger.error({ error, sessionId: session.id }, 'Could not persist session status'))
  }

  async requestPairingCode(id, phoneNumber) {
    const normalized = String(phoneNumber ?? '').replace(/\D/g, '')
    if (normalized.length < 8 || normalized.length > 15) {
      const error = new Error('phoneNumber must include country code and contain 8-15 digits')
      error.statusCode = 400
      throw error
    }

    const session = await this.connect(id)
    if (session.socket.authState?.creds?.registered || session.socket.user) {
      const error = new Error('Session is already registered')
      error.statusCode = 409
      throw error
    }
    return session.socket.requestPairingCode(normalized)
  }

  async remove(id, { logout = true } = {}) {
    const session = this.get(id)
    if (!session) return false

    clearTimeout(session.reconnectTimer)
    this.sessions.delete(id)
    session.socket.ev.removeAllListeners()
    if (logout) {
      try { await session.socket.logout() } catch (error) {
        this.logger.warn({ error, sessionId: id }, 'Logout request failed; removing local session')
      }
    } else {
      session.socket.ws?.close()
    }
    await this.pool.query('DELETE FROM whatsapp_sessions WHERE session_id = $1', [id])
    return true
  }

  async shutdown() {
    this.shuttingDown = true
    await Promise.allSettled([...this.sessions.values()].map(async (session) => {
      clearTimeout(session.reconnectTimer)
      session.socket.ev.removeAllListeners()
      session.socket.ws?.close()
    }))
  }
}
