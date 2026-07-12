import makeWASocket, {
  BufferJSON,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
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

const phoneFromJid = (jid) => {
  const value = String(jid ?? '').split('@')[0].split(':')[0]
  return /^\d{8,15}$/.test(value) ? value : null
}

const usableName = (name) => {
  if (typeof name !== 'string' || !name.trim()) return null
  return /[∙•]{3,}/.test(name) ? null : name.trim()
}

const normalizeRecipient = (recipient) => {
  if (typeof recipient !== 'string') return null
  const value = recipient.trim()
  if (/^\d{8,15}$/.test(value)) return `${value}@s.whatsapp.net`
  if (/^[a-zA-Z0-9._:-]+@(s\.whatsapp\.net|lid|g\.us|broadcast|newsletter)$/.test(value)) return value
  return null
}

const normalizeMessageInput = async (content, options) => {
  const normalizedContent = JSON.parse(JSON.stringify(content), BufferJSON.reviver)
  const normalizedOptions = JSON.parse(JSON.stringify(options ?? {}), BufferJSON.reviver)

  if (typeof normalizedContent.text === 'string' && (normalizedContent.header || normalizedContent.footer)) {
    const parts = []
    if (normalizedContent.header) parts.push(`*${String(normalizedContent.header).trim()}*`)
    if (normalizedContent.text.trim()) parts.push(normalizedContent.text.trim())
    if (normalizedContent.footer) parts.push(`_${String(normalizedContent.footer).trim()}_`)
    normalizedContent.text = parts.join('\n\n')
    delete normalizedContent.header
    delete normalizedContent.footer
  }

  if (normalizedContent.event) {
    normalizedContent.event.startDate = new Date(normalizedContent.event.startDate)
    if (normalizedContent.event.endDate) normalizedContent.event.endDate = new Date(normalizedContent.event.endDate)
  }
  if (typeof normalizedContent.poll?.messageSecret === 'string') {
    normalizedContent.poll.messageSecret = Buffer.from(normalizedContent.poll.messageSecret, 'base64')
  }
  if (normalizedContent.document) {
    if (typeof normalizedContent.jpegThumbnail === 'string') {
      normalizedContent.jpegThumbnail = Buffer.from(normalizedContent.jpegThumbnail, 'base64')
    }
    if (normalizedContent.thumbnailUrl) {
      let thumbnailUrl
      try { thumbnailUrl = new URL(normalizedContent.thumbnailUrl) } catch {
        const error = new Error('thumbnailUrl must be a valid HTTPS URL')
        error.statusCode = 400
        throw error
      }
      if (thumbnailUrl.protocol !== 'https:') {
        const error = new Error('thumbnailUrl must use HTTPS')
        error.statusCode = 400
        throw error
      }
      const response = await fetch(thumbnailUrl, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) {
        const error = new Error(`Could not download document thumbnail (HTTP ${response.status})`)
        error.statusCode = 400
        throw error
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.startsWith('image/jpeg')) {
        const error = new Error('thumbnailUrl must return a JPEG image')
        error.statusCode = 400
        throw error
      }
      const declaredSize = Number(response.headers.get('content-length') ?? 0)
      if (declaredSize > 200 * 1024) {
        const error = new Error('Document thumbnail must not exceed 200 KB')
        error.statusCode = 400
        throw error
      }
      const thumbnail = Buffer.from(await response.arrayBuffer())
      if (thumbnail.length === 0 || thumbnail.length > 200 * 1024) {
        const error = new Error('Document thumbnail must be a non-empty JPEG of at most 200 KB')
        error.statusCode = 400
        throw error
      }
      normalizedContent.jpegThumbnail = thumbnail
      delete normalizedContent.thumbnailUrl
    }
  }
  if (normalizedOptions.timestamp) normalizedOptions.timestamp = new Date(normalizedOptions.timestamp)

  return { content: normalizedContent, options: normalizedOptions }
}

export class SessionManager {
  constructor({ pool, logger }) {
    this.pool = pool
    this.logger = logger
    this.sessions = new Map()
    this.pending = new Map()
    this.shuttingDown = false
    this.waVersion = null
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
    const versionResult = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(10_000) })
    this.waVersion = versionResult.version
    this.logger.info(
      { version: this.waVersion.join('.'), isLatest: versionResult.isLatest },
      'Using WhatsApp Web protocol version'
    )
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
      authCreds: state.creds,
      saveCreds,
      status: 'connecting',
      qr: null,
      lastError: null,
      reconnectTimer: null,
      generation: (previous?.generation ?? 0) + 1,
      pairingCooldownUntil: previous?.pairingCooldownUntil ?? 0,
      contacts: previous?.contacts ?? new Map(),
      updatedAt: new Date().toISOString()
    }
    this.sessions.set(id, session)
    this.#persistStatus(session)

    const socket = makeWASocket({
      version: this.waVersion,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger)
      },
      browser: Browsers.windows('Chrome'),
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
    socket.ev.on('contacts.upsert', (contacts) => this.#mergeContacts(session, contacts))
    socket.ev.on('contacts.update', (contacts) => this.#mergeContacts(session, contacts))
    socket.ev.on('messaging-history.set', ({ contacts, chats, messages }) => {
      this.#mergeContacts(session, contacts)
      this.#mergeChats(session, chats)
      this.#mergeMessages(session, messages)
    })
    socket.ev.on('messages.upsert', ({ messages }) => this.#mergeMessages(session, messages))

    return session
  }

  #mergeContacts(session, contacts = []) {
    for (const contact of contacts) {
      if (!contact?.id || contact.id.endsWith('@g.us') || contact.id.endsWith('@broadcast')) continue
      session.contacts.set(contact.id, { ...(session.contacts.get(contact.id) ?? {}), ...contact })
    }
  }

  #mergeChats(session, chats = []) {
    for (const chat of chats) {
      if (!phoneFromJid(chat?.id)) continue
      this.#mergeContacts(session, [{ id: chat.id, name: usableName(chat.name) ?? undefined }])
    }
  }

  #mergeMessages(session, messages = []) {
    for (const message of messages) {
      const jid = message?.key?.participant || message?.key?.remoteJid
      if (!phoneFromJid(jid)) continue
      this.#mergeContacts(session, [{ id: jid, notify: usableName(message.pushName) ?? undefined }])
    }
  }

  getContacts(id) {
    const session = this.get(id)
    if (!session) {
      const error = new Error('Session not found')
      error.statusCode = 404
      throw error
    }
    if (session.status !== 'connected') {
      const error = new Error(`Session is not connected (status: ${session.status})`)
      error.statusCode = 409
      throw error
    }
    return [...session.contacts.values()].map((contact) => ({
      id: contact.id,
      lid: contact.lid ?? null,
      phoneNumber: phoneFromJid(contact.phoneNumber) ?? phoneFromJid(contact.id),
      name: usableName(contact.name),
      notify: usableName(contact.notify),
      verifiedName: usableName(contact.verifiedName),
      imgUrl: contact.imgUrl ?? null,
      status: contact.status ?? null
    }))
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

    const registrationRejected = !session.authCreds.registered && [401, 403, 405, 419].includes(code)
    if (code === DisconnectReason.loggedOut || registrationRejected) {
      session.status = registrationRejected ? 'registration_failed' : 'logged_out'
      this.logger.warn({ sessionId: session.id, code }, 'WhatsApp session registration closed')
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
    if (session.authCreds.registered) {
      const error = new Error('Session is already registered')
      error.statusCode = 409
      throw error
    }

    const cooldownMs = session.pairingCooldownUntil - Date.now()
    if (cooldownMs > 0) {
      const error = new Error(`Pairing retry is available in ${Math.ceil(cooldownMs / 1000)} seconds`)
      error.statusCode = 429
      throw error
    }

    const ready = await this.#waitForPairingReady(session, 20_000)
    if (!ready) {
      const error = new Error(`WhatsApp socket is not ready for pairing (status: ${session.status})`)
      error.statusCode = 503
      throw error
    }

    try {
      return await session.socket.requestPairingCode(normalized)
    } catch (cause) {
      session.pairingCooldownUntil = Date.now() + 10_000
      session.authCreds.me = undefined
      session.authCreds.pairingCode = undefined
      await session.saveCreds().catch((error) => {
        this.logger.error({ error, sessionId: id }, 'Could not clear incomplete pairing credentials')
      })
      const error = new Error(`WhatsApp rejected the pairing request: ${cause?.message ?? 'connection failed'}`)
      error.statusCode = 502
      error.cause = cause
      throw error
    }
  }

  async sendMessage(id, recipient, content, options = {}) {
    const session = this.get(id)
    if (!session) {
      const error = new Error('Session not found')
      error.statusCode = 404
      throw error
    }
    if (session.status !== 'connected') {
      const error = new Error(`Session is not connected (status: ${session.status})`)
      error.statusCode = 409
      throw error
    }

    const jid = normalizeRecipient(recipient)
    if (!jid) {
      const error = new Error('to must be an international phone number or a valid WhatsApp JID')
      error.statusCode = 400
      throw error
    }
    if (!content || typeof content !== 'object' || Array.isArray(content) || Object.keys(content).length === 0) {
      const error = new Error('content must be a non-empty Baileys message content object')
      error.statusCode = 400
      throw error
    }
    if ('header' in content && typeof content.header !== 'string') {
      const error = new Error('content.header must be a string')
      error.statusCode = 400
      throw error
    }
    if ('footer' in content && typeof content.footer !== 'string') {
      const error = new Error('content.footer must be a string')
      error.statusCode = 400
      throw error
    }
    if (('header' in content || 'footer' in content) && typeof content.text !== 'string') {
      const error = new Error('content.header and content.footer can only be used with a text message')
      error.statusCode = 400
      throw error
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      const error = new Error('options must be an object')
      error.statusCode = 400
      throw error
    }

    const normalized = await normalizeMessageInput(content, options)
    try {
      const message = await session.socket.sendMessage(jid, normalized.content, normalized.options)
      if (!message?.key) throw new Error('WhatsApp did not return a message key')
      return {
        sessionId: id,
        to: jid,
        messageId: message.key.id ?? null,
        key: message.key,
        status: 'sent'
      }
    } catch (cause) {
      const error = new Error(`WhatsApp message send failed: ${cause?.message ?? 'unknown error'}`)
      error.statusCode = 502
      error.cause = cause
      throw error
    }
  }

  async #waitForPairingReady(session, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (session.qr || session.status === 'connected') return true
      if (['logged_out', 'registration_failed'].includes(session.status)) return false
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
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
