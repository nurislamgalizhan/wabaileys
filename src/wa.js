// Управление сессией WhatsApp через Baileys
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import makeWASocket, {
	Browsers,
	DisconnectReason,
	downloadMediaMessage,
	fetchLatestBaileysVersion,
	isJidGroup,
	isJidNewsletter,
	isJidStatusBroadcast,
	isLidUser,
	isPnUser,
	isRealMessage,
	jidNormalizedUser,
	toNumber,
	useMultiFileAuthState,
	WAMessageStubType
} from 'baileys'
import QRCode from 'qrcode'
import { Store, STATUS_JID } from './db.js'
import { msgTimestamp, previewText, searchText, serializeContent, unwrap } from './serialize.js'

export const DEFAULT_SETTINGS = {
	online: false, // показывать «В сети»
	readReceipts: false, // синие галочки
	statusReceipts: false, // отмечать статусы просмотренными
	keepDeleted: true, // сохранять содержимое удалённых сообщений
	deviceName: '',
	rejectCalls: false,
	rejectMessage: '',
	botEnabled: false,
	aiModel: 'claude-opus-5-5',
	webhookUrl: ''
}
const BOOL_SETTINGS = ['online', 'readReceipts', 'statusReceipts', 'keepDeleted', 'rejectCalls', 'botEnabled']
const STR_SETTINGS = { rejectMessage: 1000, aiModel: 80, webhookUrl: 500 }
const PRIVACY_SETTERS = {
	last: 'updateLastSeenPrivacy',
	online: 'updateOnlinePrivacy',
	profile: 'updateProfilePicturePrivacy',
	status: 'updateStatusPrivacy',
	readreceipts: 'updateReadReceiptsPrivacy',
	groupadd: 'updateGroupsAddPrivacy',
	calladd: 'updateCallPrivacy',
	messages: 'updateMessagesPrivacy'
}

// Как устройство будет выглядеть в «Связанных устройствах» телефона.
// Название = browser[0]. Полную историю WhatsApp гарантированно отдаёт «десктопу» Mac OS / Windows.
export function browserFor(deviceName) {
	const name = String(deviceName || '').trim()
	if (!name || name === 'Mac OS') return Browsers.macOS('Desktop')
	if (name === 'Windows') return Browsers.windows('Desktop')
	return [name.slice(0, 40), 'Desktop', '1.0']
}
const MIME_EXT = {
	'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
	'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
	'audio/mp4': 'm4a', 'audio/aac': 'aac', 'application/pdf': 'pdf'
}

export class WhatsApp extends EventEmitter {
	constructor({ dataDir, logger }) {
		super()
		this.dataDir = dataDir
		this.authDir = path.join(dataDir, 'auth')
		this.mediaDir = path.join(dataDir, 'media')
		fs.mkdirSync(this.mediaDir, { recursive: true })
		this.logger = logger
		this.store = new Store(dataDir)
		this.settings = { ...DEFAULT_SETTINGS, ...this.store.get('settings', {}) }
		this.state = { connection: 'close', qr: null, pairingCode: null, me: null, sync: null, error: null }
		this.sock = null
		this.clients = new Map() // socketId -> { chatId, visible }
		this.avatarCache = new Map()
		this.mediaJobs = new Map()
		this.historyRequests = new Map()
		this.presenceSent = null
		this.reconnectDelay = 1000
		this.pnToLid = new Map([...this.store.lidToPn].map(([l, p]) => [p, l]))
		this.pendingChats = new Set()
		this.flushTimer = null
		this.buildSearchIndex()
	}

	// первичное построение полнотекстового индекса для уже сохранённых сообщений
	buildSearchIndex() {
		if (this.store.get('fts_v2')) return
		let n = 0
		this.store.tx(() => {
			this.store.clearSearchIndex()
			for (const [chatId, msg] of this.store.allMessages()) {
				this.store.putMessage(chatId, msg, msgTimestamp(msg), searchText(msg))
				n++
			}
			this.store.set('fts_v2', true)
		})
		if (n) this.logger.info({ messages: n }, 'search index built')
	}
	close() {
		this.stop()
		this.store.close()
	}

	// ---------------------------------------------------------------- state
	setState(patch) {
		Object.assign(this.state, patch)
		this.emit('state', this.publicState())
	}
	publicState() {
		return { ...this.state, settings: this.settings, hasAiKey: !!(this.store.get('secret.aiKey') || process.env.ANTHROPIC_API_KEY) }
	}
	isRegistered() {
		try {
			const creds = JSON.parse(fs.readFileSync(path.join(this.authDir, 'creds.json'), 'utf8'))
			return !!creds.registered || !!creds.me
		} catch {
			return false
		}
	}

	// ---------------------------------------------------------------- jid helpers
	learnLid(lid, pn) {
		if (!lid || !pn) return
		lid = jidNormalizedUser(lid)
		pn = jidNormalizedUser(pn)
		if (!isLidUser(lid) || !isPnUser(pn)) return
		if (!this.store.setLid(lid, pn)) return
		this.pnToLid.set(pn, lid)
		// чат мог быть создан под LID — переносим на номер
		if (this.store.mergeChat(lid, pn)) {
			this.emit('chat.removed', lid)
			this.queueChat(pn)
		}
	}
	norm(jid, alt) {
		if (!jid) return jid
		const j = jidNormalizedUser(jid)
		if (isLidUser(j)) {
			if (alt && isPnUser(jidNormalizedUser(alt))) this.learnLid(j, alt)
			return this.store.lidToPn.get(j) || j
		}
		if (alt && isLidUser(jidNormalizedUser(alt))) this.learnLid(alt, j)
		return j
	}
	meIds() {
		const me = this.sock?.user || this.state.me
		return [me?.id && jidNormalizedUser(me.id), me?.lid && jidNormalizedUser(me.lid)].filter(Boolean)
	}
	isMe(jid) {
		return !!jid && this.meIds().includes(jidNormalizedUser(jid))
	}
	nameOf(jid, pushName) {
		if (!jid) return ''
		const j = this.norm(jid)
		if (this.isMe(j)) return 'Вы'
		if (isJidGroup(j)) return this.store.getGroup(j)?.subject || this.store.getChat(j)?.name || 'Группа'
		const ids = [j, this.pnToLid.get(j)].filter(Boolean)
		const cs = ids.map((id) => this.store.getContact(id)).filter(Boolean)
		for (const k of ['name', 'notify', 'verified']) {
			const c = cs.find((c) => c[k])
			if (c) return c[k]
		}
		if (pushName) return pushName
		const chatName = this.store.getChat(j)?.name
		if (chatName) return chatName
		const user = j.split('@')[0]
		return isPnUser(j) ? '+' + user : '~' + user
	}

	// ---------------------------------------------------------------- DTO
	chatDTO(row) {
		if (!row) return null
		const last = this.store.lastMessage(row.id)
		const isGroup = !!isJidGroup(row.id)
		return {
			id: row.id,
			name: isGroup ? row.name || this.nameOf(row.id) : this.nameOf(row.id),
			isGroup,
			phone: isPnUser(row.id) ? '+' + row.id.split('@')[0] : undefined,
			unread: row.unread,
			ts: row.ts,
			archived: !!row.archived,
			pinned: !!row.pinned,
			muted: row.muted > Date.now() / 1000 || row.muted === -1,
			last: last
				? {
						text: previewText(last),
						fromMe: !!last.key.fromMe,
						status: last.status,
						sender: isGroup && !last.key.fromMe ? this.nameOf(last.key.participant, last.pushName) : undefined
					}
				: undefined
		}
	}
	messageDTO(chatId, msg) {
		const d = serializeContent(msg, (j) => this.nameOf(j))
		if (!d) return null
		const isGroup = !!isJidGroup(chatId)
		const sender = msg.key.fromMe ? this.meIds()[0] : this.norm(msg.key.participant || msg.key.remoteJid, msg.key.participantAlt)
		if (msg._edited) d.edited = true
		if (msg._edits?.length) d.edits = msg._edits
		if (msg._starred) d.starred = true
		if (msg._revoked) d.deletedAt = msg._revoked.at
		return {
			...d,
			id: msg.key.id,
			chatId,
			fromMe: !!msg.key.fromMe,
			ts: msgTimestamp(msg),
			status: msg.status ?? undefined,
			sender,
			senderName: isGroup && !msg.key.fromMe ? this.nameOf(sender, msg.pushName) : undefined,
			reactions: this.store.reactions(chatId, msg.key.id).map((r) => ({ text: r.text, fromMe: this.isMe(r.sender), name: this.nameOf(r.sender) }))
		}
	}

	// батчим обновления чатов, чтобы не заваливать клиент при синхронизации
	queueChat(id) {
		if (!id) return
		this.pendingChats.add(id)
		if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = null
				const ids = [...this.pendingChats]
				this.pendingChats.clear()
				const list = ids.map((id) => this.chatDTO(this.store.getChat(id))).filter(Boolean)
				if (list.length) this.emit('chats.update', list)
			}, 300)
		}
	}

	listChats() {
		return this.store.allChats().map((r) => this.chatDTO(r))
	}
	listMessages(chatId, before, limit = 50, after) {
		if (after != null) {
			const msgs = this.store.pageAfter(chatId, after, limit)
			return { messages: msgs.map((m) => this.messageDTO(chatId, m)).filter(Boolean), hasNewer: msgs.length === limit }
		}
		const msgs = this.store.pageMessages(chatId, before || Number.MAX_SAFE_INTEGER, limit)
		let requested = false
		if (msgs.length < limit) requested = this.requestOlder(chatId)
		return { messages: msgs.map((m) => this.messageDTO(chatId, m)).filter(Boolean), requested, hasMore: msgs.length === limit }
	}
	// запросить у телефона более старую историю чата
	requestOlder(chatId) {
		if (!this.sock || this.state.connection !== 'open') return false
		const last = this.historyRequests.get(chatId)
		if (last && Date.now() - last < 20_000) return true
		const oldest = this.store.oldestMessage(chatId)
		if (!oldest) return false
		this.historyRequests.set(chatId, Date.now())
		this.sock.fetchMessageHistory(50, oldest.key, oldest.messageTimestamp).catch((err) => this.logger.warn({ err }, 'fetchMessageHistory failed'))
		return true
	}

	// ---------------------------------------------------------------- persistence of WA data
	saveChat(chat) {
		const id = this.norm(chat.id, chat.pnJid || chat.lidJid)
		if (!id || isJidStatusBroadcast(id) || isJidNewsletter(id) || id.endsWith('@broadcast')) return
		if (chat.lidJid && chat.pnJid) this.learnLid(chat.lidJid, chat.pnJid)
		const patch = { id }
		if (chat.name) patch.name = chat.name
		if (typeof chat.unreadCount === 'number') {
			if (chat.unreadCount === -1) patch.unread = Math.max(1, this.store.getChat(id)?.unread || 0)
			else if (chat.unreadCount === 0) patch.unread = 0
			else if (chat._absoluteUnread) patch.unread = chat.unreadCount
		}
		if (chat.conversationTimestamp) patch.ts = Math.max(toNumber(chat.conversationTimestamp), this.store.getChat(id)?.ts || 0)
		if (typeof chat.archived === 'boolean') patch.archived = chat.archived ? 1 : 0
		if ('pinned' in chat) patch.pinned = chat.pinned ? toNumber(chat.pinned) || 1 : 0
		if ('pin' in chat) patch.pinned = chat.pin ? toNumber(chat.pin) || 1 : 0
		// время окончания «без звука»: WhatsApp присылает то секунды, то миллисекунды; -1 = навсегда
		const muteSec = (v) => {
			const n = v ? toNumber(v) : 0
			return n > 1e11 ? Math.floor(n / 1000) : n
		}
		if ('muteEndTime' in chat) patch.muted = muteSec(chat.muteEndTime)
		if ('mute' in chat) patch.muted = muteSec(chat.mute)
		this.store.upsertChat(patch)
		this.queueChat(id)
	}
	saveContact(c) {
		if (!c?.id) return
		if (c.lid && c.phoneNumber) this.learnLid(c.lid, c.phoneNumber)
		else if (isLidUser(c.id) && c.phoneNumber) this.learnLid(c.id, c.phoneNumber)
		else if (isPnUser(c.id) && c.lid) this.learnLid(c.lid, c.id)
		const id = this.norm(c.id)
		if (c.name || c.notify || c.verifiedName) this.store.upsertContact({ id, name: c.name, notify: c.notify, verified: c.verifiedName })
		if (c.imgUrl === 'changed') this.avatarCache.delete(id)
	}
	saveGroup(g) {
		if (!g?.id) return
		const data = { ...g }
		delete data.participants // экономим место, участники нужны редко
		const saved = this.store.upsertGroup(data)
		if (g.participants) {
			for (const p of g.participants) {
				if (p.lid && p.phoneNumber) this.learnLid(p.lid, p.phoneNumber)
				else if (isLidUser(p.id) && p.phoneNumber) this.learnLid(p.id, p.phoneNumber)
			}
		}
		if (saved.subject) {
			this.store.upsertChat({ id: g.id, name: saved.subject })
			this.queueChat(g.id)
		}
	}

	// сохранить сообщение; возвращает { chatId, msg } или null
	saveMessage(msg, { live = false } = {}) {
		const key = msg.key
		if (!key?.remoteJid || !key.id) return null
		if (isJidStatusBroadcast(key.remoteJid)) return this.saveStatus(msg)
		if (isJidNewsletter(key.remoteJid) || key.remoteJid.endsWith('@broadcast')) return null
		const chatId = this.norm(key.remoteJid, key.remoteJidAlt)
		if (key.participant && key.participantAlt) this.norm(key.participant, key.participantAlt)
		const sender = key.fromMe ? null : this.norm(key.participant || key.remoteJid, key.participantAlt)
		if (sender && msg.pushName && !isJidGroup(sender)) this.store.upsertContact({ id: sender, notify: msg.pushName })

		// реакции из истории
		if (Array.isArray(msg.reactions)) {
			for (const r of msg.reactions) {
				const rs = r.key?.fromMe ? this.meIds()[0] : this.norm(r.key?.participant || r.key?.remoteJid)
				if (rs) this.store.setReaction(chatId, key.id, rs, r.text, toNumber(r.senderTimestampMs) / 1000)
			}
		}
		const content = unwrap(msg.message)
		if (content?.reactionMessage && !live) {
			const r = content.reactionMessage
			const rs = key.fromMe ? this.meIds()[0] : sender
			if (r.key?.id && rs) this.store.setReaction(chatId, r.key.id, rs, r.text, msgTimestamp(msg))
			this.queueChat(chatId)
			return null
		}

		if (!serializeContent(msg)) return null
		const existing = this.store.getMessage(chatId, key.id)
		if (existing) {
			// не затираем более свежий статус / правки
			if ((existing.status || 0) > (msg.status || 0)) msg.status = existing.status
			if (existing._edited) {
				msg.message = existing.message
				msg._edited = true
			}
			for (const k of ['_readSent', '_starred', '_edits', '_revoked']) if (existing[k] && !msg[k]) msg[k] = existing[k]
			if (existing._revoked && existing.message) msg.message = existing.message
		}
		const ts = msgTimestamp(msg)
		this.store.putMessage(chatId, msg, ts, searchText(msg))

		const chat = this.store.getChat(chatId)
		const patch = { id: chatId, ts: Math.max(chat?.ts || 0, ts) }
		if (!chat && isJidGroup(chatId)) patch.name = this.store.getGroup(chatId)?.subject
		if (live && !existing && !key.fromMe && isRealMessage(msg) && msg.messageStubType == null) {
			patch.unread = (chat?.unread || 0) + 1
		}
		if (live && key.fromMe && !existing) patch.unread = 0 // ответили с телефона — значит прочитано там
		this.store.upsertChat(patch)
		this.queueChat(chatId)
		return { chatId, msg, isNew: !existing }
	}

	// ---------------------------------------------------------------- connection
	async start() {
		if (this.sock) return
		this.setState({ connection: 'connecting', error: null })
		const { state, saveCreds } = await useMultiFileAuthState(this.authDir)
		// показываем закэшированные чаты, пока идёт подключение
		if (state.creds.me && !this.state.me) {
			const m = state.creds.me
			this.setState({ me: { id: jidNormalizedUser(m.id), lid: m.lid && jidNormalizedUser(m.lid), name: m.name || m.notify } })
		}
		let version
		try {
			;({ version } = await fetchLatestBaileysVersion())
		} catch {}
		const sock = makeWASocket({
			version,
			auth: state,
			logger: this.logger.child({ module: 'baileys' }),
			browser: browserFor(this.settings.deviceName), // «десктоп» получает полную историю
			markOnlineOnConnect: this.settings.online && this.anyVisible(),
			syncFullHistory: true,
			shouldSyncHistoryMessage: () => true,
			emitOwnEvents: true,
			generateHighQualityLinkPreview: true,
			getMessage: async (key) => {
				const m = this.store.getMessage(this.norm(key.remoteJid, key.remoteJidAlt), key.id) || this.store.findMessage(key.id)
				return m?.message || undefined
			}
		})
		this.sock = sock
		this.presenceSent = null
		this.bindEvents(sock, saveCreds)
	}

	async stop() {
		const sock = this.sock
		this.sock = null
		if (sock) {
			sock.ev.removeAllListeners()
			try {
				sock.end(undefined)
			} catch {}
		}
	}

	async logout() {
		const sock = this.sock
		if (sock) {
			try {
				await sock.logout()
			} catch {}
		}
		await this.stop()
		this.wipe()
		this.setState({ connection: 'close', qr: null, pairingCode: null, me: null, sync: null })
		this.emit('reset')
	}

	wipe() {
		fs.rmSync(this.authDir, { recursive: true, force: true })
		fs.rmSync(this.mediaDir, { recursive: true, force: true })
		fs.mkdirSync(this.mediaDir, { recursive: true })
		this.store.clearAll()
		this.pnToLid.clear()
		this.avatarCache.clear()
	}

	async loginWithCode(phone) {
		phone = String(phone || '').replace(/\D/g, '')
		if (phone.length < 8) throw new Error('Неверный номер телефона')
		if (this.isRegistered()) throw new Error('Уже авторизовано')
		if (!this.sock) await this.start()
		// ждём, пока сокет будет готов (появится первый QR)
		if (!this.state.qr) {
			await new Promise((resolve, reject) => {
				const t = setTimeout(() => {
					this.off('state', h)
					reject(new Error('WhatsApp не ответил, попробуйте ещё раз'))
				}, 20_000)
				const h = (s) => {
					if (s.qr) {
						clearTimeout(t)
						this.off('state', h)
						resolve()
					}
				}
				this.on('state', h)
			})
		}
		const code = await this.sock.requestPairingCode(phone)
		const pretty = code?.match(/.{1,4}/g)?.join('-') || code
		this.setState({ pairingCode: pretty })
		return pretty
	}

	bindEvents(sock, saveCreds) {
		const ev = sock.ev
		ev.on('creds.update', saveCreds)

		ev.on('connection.update', async (u) => {
			if (sock !== this.sock) return
			const { connection, lastDisconnect, qr } = u
			if (qr) {
				const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 })
				this.setState({ qr: dataUrl, connection: 'qr' })
			}
			if (connection === 'open') {
				this.reconnectDelay = 1000
				this.preLoginRetries = 0
				const me = sock.user ? { id: jidNormalizedUser(sock.user.id), lid: sock.user.lid && jidNormalizedUser(sock.user.lid), name: sock.user.name || sock.user.notify || sock.user.verifiedName } : null
				if (me?.lid && me?.id) this.learnLid(me.lid, me.id)
				this.setState({ connection: 'open', qr: null, pairingCode: null, me })
				this.presenceSent = this.settings.online && this.anyVisible() ? 'available' : 'unavailable'
				sock
					.groupFetchAllParticipating()
					.then((groups) => {
						this.store.tx(() => Object.values(groups).forEach((g) => this.saveGroup(g)))
					})
					.catch((err) => this.logger.warn({ err }, 'groupFetchAllParticipating failed'))
			}
			if (connection === 'close') {
				const code = lastDisconnect?.error?.output?.statusCode
				this.logger.info({ code }, 'connection closed')
				this.sock = null
				sock.ev.removeAllListeners()
				if (code === DisconnectReason.loggedOut || code === DisconnectReason.forbidden) {
					this.wipe()
					this.setState({ connection: 'close', qr: null, pairingCode: null, me: null, sync: null, error: 'Сессия завершена. Войдите снова.' })
					this.emit('reset')
					return
				}
				if (!this.isRegistered() && code !== DisconnectReason.restartRequired) {
					// обрыв до появления QR — пробуем ещё пару раз
					if (!this.state.qr && code !== DisconnectReason.timedOut && (this.preLoginRetries = (this.preLoginRetries || 0) + 1) <= 3) {
						setTimeout(() => this.start().catch(() => {}), 2000)
						return
					}
					this.preLoginRetries = 0
					// QR истёк, а вход так и не выполнен — ждём действия пользователя
					const error = code === DisconnectReason.timedOut ? 'QR-код устарел' : this.state.qr ? null : `Не удалось подключиться к WhatsApp (код ${code ?? '?'}). Проверьте сеть.`
					this.setState({ connection: 'close', qr: null, pairingCode: null, error })
					return
				}
				this.setState({ connection: 'connecting', qr: null })
				const delay = code === DisconnectReason.restartRequired ? 0 : this.reconnectDelay
				this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
				setTimeout(() => this.start().catch((err) => this.logger.error({ err }, 'restart failed')), delay)
			}
		})

		ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings, progress, syncType, isLatest }) => {
			this.logger.info({ chats: chats.length, contacts: contacts.length, messages: messages.length, progress, syncType }, 'history sync')
			const touched = new Set()
			this.store.tx(() => {
				for (const m of lidPnMappings || []) this.learnLid(m.lid, m.pn)
				for (const c of contacts) this.saveContact(c)
				for (const c of chats) this.saveChat({ ...c, _absoluteUnread: true })
				for (const m of messages) {
					const r = this.saveMessage(m)
					if (r) touched.add(r.chatId)
				}
			})
			if (progress != null) this.setState({ sync: progress >= 100 ? null : Math.round(progress) })
			// ON_DEMAND (6) — ответ на запрос старых сообщений
			for (const chatId of touched) this.emit('chat.history', chatId)
		})

		ev.on('messaging-history.status', ({ status }) => {
			if (status === 'complete') this.setState({ sync: null })
		})

		ev.on('lid-mapping.update', ({ lid, pn }) => this.learnLid(lid, pn))

		ev.on('chats.upsert', (chats) => this.store.tx(() => chats.forEach((c) => this.saveChat({ ...c, _absoluteUnread: true }))))
		ev.on('chats.update', (updates) => this.store.tx(() => updates.forEach((c) => this.saveChat(c))))
		ev.on('chats.delete', (ids) => {
			for (const id of ids) {
				const n = this.norm(id)
				this.store.deleteChat(n)
				this.emit('chat.removed', n)
			}
		})

		ev.on('contacts.upsert', (cs) => this.store.tx(() => cs.forEach((c) => this.saveContact(c))))
		ev.on('contacts.update', (cs) => this.store.tx(() => cs.forEach((c) => this.saveContact(c))))

		ev.on('groups.upsert', (gs) => this.store.tx(() => gs.forEach((g) => this.saveGroup(g))))
		ev.on('groups.update', (gs) => this.store.tx(() => gs.forEach((g) => this.saveGroup(g))))

		ev.on('messages.upsert', ({ messages, type }) => {
			for (const m of messages) {
				const live = type === 'notify' || type === 'append'
				// реакции в реальном времени приходят отдельным событием messages.reaction
				const r = this.saveMessage(m, { live })
				if (!r) continue
				if (r.chatId === STATUS_JID) {
					if (r.isNew) this.emit('status.new', this.messageDTO(STATUS_JID, r.msg))
					continue
				}
				const dto = this.messageDTO(r.chatId, r.msg)
				if (dto) this.emit(r.isNew ? 'message.new' : 'message.update', dto)
				if (r.isNew && type === 'notify' && dto) {
					// для автоответчика, вебхуков
					this.emit('incoming', { dto, msg: r.msg, chat: this.store.getChat(r.chatId) })
					if (!m.key.fromMe) this.autoRead(r.chatId)
				}
			}
		})

		ev.on('messages.update', (updates) => {
			for (const { key, update } of updates) {
				const chatId = this.norm(key.remoteJid, key.remoteJidAlt)
				const msg = this.store.getMessage(chatId, key.id)
				if (!msg) continue
				if (update.message === null || update.messageStubType === WAMessageStubType.REVOKE) {
					if (this.settings.keepDeleted && msg.message && !msg._revoked) {
						// «антиудаление»: сохраняем содержимое, помечаем как удалённое
						msg._revoked = { at: Math.floor(Date.now() / 1000) }
					} else if (!msg._revoked) {
						msg.message = null
						msg.messageStubType = WAMessageStubType.REVOKE
					}
				} else if (update.message?.editedMessage?.message) {
					// история правок: запоминаем прежний текст
					const before = previewText(msg)
					msg._edits = [...(msg._edits || []), { text: before, ts: Math.floor(Date.now() / 1000) }].slice(-20)
					msg.message = update.message.editedMessage.message
					msg._edited = true
				}
				if (update.status != null) msg.status = Math.max(msg.status || 0, update.status)
				if (update.starred != null) msg._starred = !!update.starred
				this.store.putMessage(chatId, msg, msgTimestamp(msg), searchText(msg))
				const dto = this.messageDTO(chatId, msg)
				if (dto) this.emit('message.update', dto)
				this.queueChat(chatId)
			}
		})

		ev.on('message-receipt.update', (updates) => {
			for (const { key, receipt } of updates) {
				const chatId = this.norm(key.remoteJid, key.remoteJidAlt)
				const msg = this.store.getMessage(chatId, key.id)
				if (!msg || !msg.key.fromMe) continue
				const status = receipt.playedTimestamp ? 5 : receipt.readTimestamp ? 4 : receipt.receiptTimestamp ? 3 : 0
				if (status > (msg.status || 0)) {
					msg.status = status
					this.store.putMessage(chatId, msg, msgTimestamp(msg))
					const dto = this.messageDTO(chatId, msg)
					if (dto) this.emit('message.update', dto)
					this.queueChat(chatId)
				}
			}
		})

		ev.on('messages.reaction', (items) => {
			for (const { key, reaction } of items) {
				const chatId = this.norm(key.remoteJid, key.remoteJidAlt)
				const rk = reaction.key || {}
				const sender = rk.fromMe ? this.meIds()[0] : this.norm(rk.participant || rk.remoteJid, rk.participantAlt)
				if (!sender) continue
				this.store.setReaction(chatId, key.id, sender, reaction.text, toNumber(reaction.senderTimestampMs) / 1000)
				const msg = this.store.getMessage(chatId, key.id)
				if (msg) {
					const dto = this.messageDTO(chatId, msg)
					if (dto) this.emit('message.update', dto)
				}
			}
		})

		ev.on('messages.delete', (item) => {
			if ('all' in item) {
				const id = this.norm(item.jid)
				this.store.deleteChat(id)
				this.emit('chat.removed', id)
				return
			}
			for (const key of item.keys) {
				const chatId = this.norm(key.remoteJid, key.remoteJidAlt)
				this.store.deleteMessage(chatId, key.id)
				this.emit('message.delete', { chatId, id: key.id })
				this.queueChat(chatId)
			}
		})

		ev.on('call', (calls) => {
			for (const c of calls) this.onCall(c).catch((err) => this.logger.warn({ err }, 'call handling failed'))
		})

		ev.on('presence.update', ({ id, presences }) => {
			const chatId = this.norm(id)
			const out = {}
			for (const [jid, p] of Object.entries(presences)) {
				out[this.norm(jid)] = { state: p.lastKnownPresence, lastSeen: p.lastSeen, name: this.nameOf(jid) }
			}
			this.emit('presence', { chatId, presences: out })
		})
	}

	// ---------------------------------------------------------------- privacy: online / read
	anyVisible() {
		for (const c of this.clients.values()) if (c.visible) return true
		return false
	}
	setClient(id, info) {
		if (info) this.clients.set(id, { ...this.clients.get(id), ...info })
		else this.clients.delete(id)
		this.syncPresence()
		if (info?.chatId && info.visible) this.autoRead(info.chatId)
	}
	async syncPresence() {
		if (!this.sock || this.state.connection !== 'open') return
		const want = this.settings.online && this.anyVisible() ? 'available' : 'unavailable'
		if (this.presenceSent === want) return
		this.presenceSent = want
		try {
			await this.sock.sendPresenceUpdate(want)
		} catch (err) {
			this.logger.warn({ err }, 'presence update failed')
		}
	}
	updateSettings(patch) {
		for (const k of BOOL_SETTINGS) if (typeof patch[k] === 'boolean') this.settings[k] = patch[k]
		for (const [k, max] of Object.entries(STR_SETTINGS)) if (typeof patch[k] === 'string') this.settings[k] = patch[k].trim().slice(0, max)
		if (typeof patch.aiKey === 'string') this.store.set('secret.aiKey', patch.aiKey.trim())
		if (typeof patch.deviceName === 'string' && patch.deviceName.trim() !== this.settings.deviceName) {
			this.settings.deviceName = patch.deviceName.trim().slice(0, 40)
			// имя передаётся при привязке: если вход ещё не выполнен — пересоздаём сокет с новым именем
			if (!this.isRegistered() && this.sock) {
				this.stop().then(() => this.start()).catch((err) => this.logger.error({ err }, 'restart failed'))
			}
		}
		this.store.set('settings', this.settings)
		this.presenceSent = null
		this.syncPresence()
		this.emit('state', this.publicState())
		return this.settings
	}
	// чат открыт в видимой вкладке → отмечаем прочитанным (если разрешено)
	autoRead(chatId) {
		let open = false
		for (const c of this.clients.values()) if (c.visible && c.chatId === chatId) open = true
		if (!open || !this.settings.readReceipts) return
		this.markRead(chatId).catch((err) => this.logger.warn({ err }, 'auto read failed'))
	}
	// отправить отчёты о прочтении (синие галочки)
	async markRead(chatId, force = false) {
		const chat = this.store.getChat(chatId)
		if (!chat || (!force && !chat.unread)) return
		const count = Math.max(chat.unread || 0, 1)
		const msgs = this.store.recentIncoming(chatId, Math.min(count, 300)).filter((m) => !m._readSent && m.message)
		if (this.sock && this.state.connection === 'open' && msgs.length) {
			await this.sock.readMessages(msgs.map((m) => m.key))
			this.store.tx(() => msgs.forEach((m) => this.store.putMessage(chatId, { ...m, _readSent: true }, msgTimestamp(m))))
		}
		this.store.upsertChat({ id: chatId, unread: 0 })
		this.queueChat(chatId)
	}
	async markPlayed(chatId, msgId) {
		if (!this.settings.readReceipts || !this.sock) return
		const m = this.store.getMessage(chatId, msgId)
		if (!m || m.key.fromMe) return
		await this.sock.sendReceipt(m.key.remoteJid, m.key.participant, [m.key.id], 'played')
	}
	async markUnread(chatId) {
		const last = this.store.lastMessage(chatId)
		if (this.sock && last) {
			await this.sock.chatModify({ markRead: false, lastMessages: [{ key: last.key, messageTimestamp: last.messageTimestamp }] }, chatId).catch(() => {})
		}
		this.store.upsertChat({ id: chatId, unread: Math.max(1, this.store.getChat(chatId)?.unread || 0) })
		this.queueChat(chatId)
	}
	async typing(chatId, composing) {
		// индикатор «печатает…» выдаёт присутствие — шлём только в режиме «В сети»
		if (!this.settings.online || !this.sock || this.state.connection !== 'open') return
		await this.sock.sendPresenceUpdate(composing ? 'composing' : 'paused', chatId).catch(() => {})
	}
	async subscribePresence(chatId) {
		if (!this.sock || this.state.connection !== 'open' || isJidGroup(chatId)) return
		await this.sock.presenceSubscribe(chatId).catch(() => {})
	}

	// ---------------------------------------------------------------- sending
	requireSock() {
		if (!this.sock || this.state.connection !== 'open') throw new Error('Нет подключения к WhatsApp')
		return this.sock
	}
	async sendText(chatId, text, quotedId) {
		const sock = this.requireSock()
		const quoted = quotedId ? this.store.getMessage(chatId, quotedId) : undefined
		await sock.sendMessage(chatId, { text }, { quoted })
	}
	async sendMedia(chatId, { kind, data, mimetype, fileName, caption, quotedId }) {
		const sock = this.requireSock()
		const quoted = quotedId ? this.store.getMessage(chatId, quotedId) : undefined
		let buf = Buffer.from(data)
		let content
		if (kind === 'voice') {
			if (!/ogg/.test(mimetype || '')) buf = await toOggOpus(buf)
			content = { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true }
		} else if (kind === 'image') content = { image: buf, caption, mimetype }
		else if (kind === 'video') content = { video: buf, caption, mimetype }
		else if (kind === 'audio') content = { audio: buf, mimetype }
		else content = { document: buf, mimetype: mimetype || 'application/octet-stream', fileName: fileName || 'file', caption }
		await sock.sendMessage(chatId, content, { quoted })
	}
	async react(chatId, msgId, emoji) {
		const sock = this.requireSock()
		const m = this.store.getMessage(chatId, msgId)
		if (!m) throw new Error('Сообщение не найдено')
		await sock.sendMessage(chatId, { react: { text: emoji || '', key: m.key } })
	}
	async deleteForAll(chatId, msgId) {
		const sock = this.requireSock()
		const m = this.store.getMessage(chatId, msgId)
		if (!m) throw new Error('Сообщение не найдено')
		await sock.sendMessage(chatId, { delete: m.key })
	}

	// ---------------------------------------------------------------- media & avatars
	async getMedia(chatId, msgId) {
		const hash = crypto.createHash('sha1').update(chatId + '|' + msgId).digest('hex')
		const existing = fs.readdirSync(this.mediaDir).find((f) => f.startsWith(hash))
		const msg = this.store.getMessage(chatId, msgId)
		const content = msg && unwrap(msg.message)
		const media = content && (content.imageMessage || content.videoMessage || content.ptvMessage || content.audioMessage || content.documentMessage || content.stickerMessage)
		const mimetype = (media?.mimetype || 'application/octet-stream').split(';')[0].trim()
		if (existing) return { file: path.join(this.mediaDir, existing), mimetype, fileName: media?.fileName }
		if (!msg || !media) throw new Error('Медиа не найдено')
		if (this.mediaJobs.has(hash)) return this.mediaJobs.get(hash)
		const job = (async () => {
			const sock = this.sock
			const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: this.logger, reuploadRequest: sock ? sock.updateMediaMessage : async (m) => m })
			const ext = MIME_EXT[mimetype] || mimetype.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'
			const file = path.join(this.mediaDir, `${hash}.${ext}`)
			fs.writeFileSync(file, buf)
			return { file, mimetype, fileName: media.fileName }
		})().finally(() => this.mediaJobs.delete(hash))
		this.mediaJobs.set(hash, job)
		return job
	}
	async getAvatar(jid) {
		const cached = this.avatarCache.get(jid)
		if (cached && Date.now() - cached.at < 6 * 3600_000) return cached.url
		if (!this.sock || this.state.connection !== 'open') return cached?.url || null
		let url = null
		try {
			url = (await this.sock.profilePictureUrl(jid, 'preview', 8000)) || null
		} catch {}
		this.avatarCache.set(jid, { url, at: Date.now() })
		return url
	}
	async groupInfo(chatId) {
		let g = this.store.getGroup(chatId)
		if (this.sock && this.state.connection === 'open') {
			try {
				const full = await this.sock.groupMetadata(chatId)
				this.saveGroup(full)
				g = full
			} catch {}
		}
		if (!g) return null
		return {
			id: g.id,
			subject: g.subject,
			desc: g.desc,
			owner: g.owner,
			creation: g.creation,
			participants: (g.participants || []).map((p) => {
				const id = this.norm(p.id, p.phoneNumber)
				return { id, name: this.nameOf(id), admin: p.admin || null }
			})
		}
	}
	// ================================================================ статусы (истории)
	saveStatus(msg) {
		const key = msg.key
		if (!serializeContent(msg)) return null
		const existing = this.store.getMessage(STATUS_JID, key.id)
		if (existing?._seen) msg._seen = true
		if (existing?._readSent) msg._readSent = true
		const sender = key.fromMe ? this.meIds()[0] : this.norm(key.participant, key.participantAlt)
		if (sender && msg.pushName) this.store.upsertContact({ id: sender, notify: msg.pushName })
		this.store.putMessage(STATUS_JID, msg, msgTimestamp(msg))
		return { chatId: STATUS_JID, msg, isNew: !existing }
	}
	listStatuses() {
		const since = Math.floor(Date.now() / 1000) - 24 * 3600
		this.store.deleteOlder(STATUS_JID, since - 24 * 3600) // храним не дольше двух суток
		const groups = new Map()
		for (const m of this.store.messagesSince(STATUS_JID, since)) {
			const dto = this.messageDTO(STATUS_JID, m)
			if (!dto) continue
			dto.seen = !!m._seen
			const sender = dto.fromMe ? 'me' : dto.sender
			if (!groups.has(sender)) groups.set(sender, { sender, jid: dto.sender, name: dto.fromMe ? 'Мой статус' : this.nameOf(dto.sender, m.pushName), items: [] })
			groups.get(sender).items.push(dto)
		}
		return [...groups.values()]
			.map((g) => ({ ...g, ts: g.items[g.items.length - 1].ts, unseen: g.items.filter((i) => !i.seen && !i.fromMe).length }))
			.sort((a, b) => (a.sender === 'me' ? -1 : b.sender === 'me' ? 1 : (b.unseen > 0) - (a.unseen > 0) || b.ts - a.ts))
	}
	// просмотр статуса: локально всегда, а отчёт автору — только если разрешено
	async viewStatus(id) {
		const m = this.store.getMessage(STATUS_JID, id)
		if (!m) return
		m._seen = true
		if (this.settings.statusReceipts && !m.key.fromMe && !m._readSent && this.sock && this.state.connection === 'open') {
			await this.sock.readMessages([m.key])
			m._readSent = true
		}
		this.store.putMessage(STATUS_JID, m, msgTimestamp(m))
	}

	// ================================================================ звонки
	async onCall(c) {
		const from = this.norm(c.from, c.callerPn)
		const call = { id: c.id, from, name: this.nameOf(from), isVideo: !!c.isVideo, isGroup: !!c.isGroup, status: c.status, ts: Math.floor(new Date(c.date || Date.now()).getTime() / 1000) }
		const prev = this.store.calls().find((x) => x.id === c.id)
		if (c.status === 'offer' && !c.offline && this.settings.rejectCalls && this.sock) {
			await this.sock.rejectCall(c.id, c.from)
			call.rejected = true
			if (this.settings.rejectMessage) await this.sock.sendMessage(from, { text: this.settings.rejectMessage }).catch(() => {})
		}
		const merged = { ...prev, ...call, rejected: call.rejected || prev?.rejected }
		this.store.saveCall(merged)
		this.emit('call', merged)
	}
	listCalls() {
		return this.store.calls()
	}

	// ================================================================ поиск
	search(query) {
		return this.store.search(query).map((r) => {
			const chat = this.store.getChat(r.chat_id)
			return {
				chatId: r.chat_id,
				id: r.msg_id,
				ts: r.ts,
				chatName: chat ? this.chatDTO(chat).name : this.nameOf(r.chat_id),
				snippet: r.snip
			}
		})
	}
	// окно сообщений вокруг найденного
	messagesAround(chatId, id) {
		const target = this.store.getMessage(chatId, id)
		if (!target) throw new Error('Сообщение не найдено')
		const ts = msgTimestamp(target)
		const before = this.store.pageMessages(chatId, ts, 30)
		const after = this.store.pageAfter(chatId, ts, 30)
		const seen = new Set()
		const all = [...before, ...after].filter((m) => !seen.has(m.key.id) && seen.add(m.key.id))
		return { messages: all.map((m) => this.messageDTO(chatId, m)).filter(Boolean), hasNewer: after.length === 30, hasMore: before.length === 30 }
	}

	// ================================================================ действия с сообщениями
	getMsgOrThrow(chatId, msgId) {
		const m = this.store.getMessage(chatId, msgId)
		if (!m) throw new Error('Сообщение не найдено')
		return m
	}
	async editMessage(chatId, msgId, text) {
		const sock = this.requireSock()
		const m = this.getMsgOrThrow(chatId, msgId)
		if (!m.key.fromMe) throw new Error('Можно изменять только свои сообщения')
		if (Date.now() / 1000 - msgTimestamp(m) > 15 * 60) throw new Error('WhatsApp разрешает изменять сообщение только 15 минут')
		await sock.sendMessage(chatId, { text, edit: m.key })
	}
	async forwardMessage(chatId, msgId, toChatIds) {
		const sock = this.requireSock()
		const m = this.getMsgOrThrow(chatId, msgId)
		for (const to of toChatIds) await sock.sendMessage(to, { forward: m })
	}
	async starMessage(chatId, msgId, star) {
		const m = this.getMsgOrThrow(chatId, msgId)
		if (this.sock && this.state.connection === 'open') await this.sock.star(chatId, [{ id: m.key.id, fromMe: !!m.key.fromMe }], !!star).catch(() => {})
		m._starred = !!star
		this.store.putMessage(chatId, m, msgTimestamp(m))
		this.emit('message.update', this.messageDTO(chatId, m))
	}
	listStarred() {
		const out = []
		for (const [chatId, m] of this.store.allMessages()) if (m._starred) out.push(this.messageDTO(chatId, m))
		return out.filter(Boolean).sort((a, b) => b.ts - a.ts)
	}
	async deleteForMe(chatId, msgId) {
		const m = this.getMsgOrThrow(chatId, msgId)
		if (this.sock && this.state.connection === 'open') {
			await this.sock.chatModify({ deleteForMe: { deleteMedia: true, key: m.key, timestamp: msgTimestamp(m) } }, chatId).catch(() => {})
		}
		this.store.deleteMessage(chatId, msgId)
		this.emit('message.delete', { chatId, id: msgId })
		this.queueChat(chatId)
	}

	// ================================================================ действия с чатами
	lastMessages(chatId) {
		const last = this.store.lastMessage(chatId)
		return last ? [{ key: last.key, messageTimestamp: last.messageTimestamp }] : []
	}
	async chatAction(chatId, action, value) {
		const sock = this.requireSock()
		const lastMessages = this.lastMessages(chatId)
		switch (action) {
			case 'archive':
				await sock.chatModify({ archive: !!value, lastMessages }, chatId)
				this.store.upsertChat({ id: chatId, archived: value ? 1 : 0 })
				break
			case 'pin':
				await sock.chatModify({ pin: !!value }, chatId)
				this.store.upsertChat({ id: chatId, pinned: value ? Math.floor(Date.now() / 1000) : 0 })
				break
			case 'mute': {
				// value — длительность в секундах, -1 = навсегда, 0 = включить звук
				const until = value === -1 ? -1 : value ? Math.floor(Date.now() / 1000) + value : 0
				await sock.chatModify({ mute: value ? (value === -1 ? -1 : until * 1000) : null }, chatId)
				this.store.upsertChat({ id: chatId, muted: until })
				break
			}
			case 'clear':
				await sock.chatModify({ clear: true, lastMessages }, chatId).catch(() => {})
				this.store.tx(() => {
					for (const m of this.store.pageMessages(chatId, Number.MAX_SAFE_INTEGER, 1e9)) this.store.deleteMessage(chatId, m.key.id)
				})
				this.emit('chat.cleared', chatId)
				break
			case 'delete':
				await sock.chatModify({ delete: true, lastMessages }, chatId).catch(() => {})
				this.store.deleteChat(chatId)
				this.emit('chat.removed', chatId)
				return
			case 'block':
			case 'unblock':
				await sock.updateBlockStatus(chatId, action)
				this.blocklist = null
				break
			default:
				throw new Error('Неизвестное действие')
		}
		this.queueChat(chatId)
	}
	async getBlocklist() {
		if (!this.blocklist && this.sock) this.blocklist = await this.sock.fetchBlocklist().catch(() => [])
		return (this.blocklist || []).map((j) => this.norm(j))
	}
	async contactInfo(jid) {
		const out = { id: jid, name: this.nameOf(jid), phone: isPnUser(jid) ? '+' + jid.split('@')[0] : undefined }
		if (this.sock && this.state.connection === 'open') {
			const [st] = (await this.sock.fetchStatus(jid).catch(() => null)) || []
			if (st?.status?.status) out.about = st.status.status
			out.blocked = (await this.getBlocklist()).includes(jid)
			const biz = await this.sock.getBusinessProfile(jid).catch(() => null)
			if (biz) out.business = { description: biz.description, website: biz.website?.[0], email: biz.email, address: biz.address, category: biz.category }
		}
		return out
	}
	listContacts() {
		const map = new Map()
		for (const c of this.store.allContacts()) map.set(c.id, { id: c.id, name: c.name || c.notify || c.verified, saved: !!c.name })
		for (const r of this.store.allChats()) if (!map.has(r.id)) map.set(r.id, { id: r.id, name: this.chatDTO(r).name, isGroup: !!isJidGroup(r.id) })
		return [...map.values()].filter((c) => c.name).sort((a, b) => a.name.localeCompare(b.name, 'ru'))
	}
	async checkNumbers(phones) {
		const sock = this.requireSock()
		const list = phones.map((p) => String(p).replace(/\D/g, '')).filter((p) => p.length >= 8)
		const res = (await sock.onWhatsApp(...list)) || []
		return list.map((p) => {
			const r = res.find((x) => x.jid?.startsWith(p + '@'))
			return { phone: p, exists: !!r?.exists, jid: r?.jid ? jidNormalizedUser(r.jid) : p + '@s.whatsapp.net' }
		})
	}

	// ================================================================ профиль и приватность аккаунта
	async getProfile() {
		const sock = this.requireSock()
		const me = this.meIds()[0]
		const [st] = (await sock.fetchStatus(me).catch(() => null)) || []
		const privacy = await sock.fetchPrivacySettings(true).catch(() => ({}))
		return { id: me, name: this.state.me?.name, about: st?.status?.status || '', privacy }
	}
	async setProfile({ name, about, photo, removePhoto }) {
		const sock = this.requireSock()
		const me = this.meIds()[0]
		if (typeof name === 'string' && name.trim()) {
			await sock.updateProfileName(name.trim())
			this.setState({ me: { ...this.state.me, name: name.trim() } })
		}
		if (typeof about === 'string') await sock.updateProfileStatus(about)
		if (photo) await sock.updateProfilePicture(me, Buffer.from(photo))
		if (removePhoto) await sock.removeProfilePicture(me)
		if (photo || removePhoto) this.avatarCache.delete(me)
	}
	async setPrivacy(key, value) {
		const sock = this.requireSock()
		if (key === 'disappearing') return sock.updateDefaultDisappearingMode(Number(value) || 0)
		const fn = PRIVACY_SETTERS[key]
		if (!fn) throw new Error('Неизвестная настройка')
		await sock[fn](value)
	}

	// ================================================================ группы
	async createGroup(subject, participants) {
		const sock = this.requireSock()
		const jids = participants.map((p) => (p.includes('@') ? p : String(p).replace(/\D/g, '') + '@s.whatsapp.net'))
		const g = await sock.groupCreate(subject, jids)
		this.saveGroup(g)
		this.store.upsertChat({ id: g.id, name: g.subject, ts: Math.floor(Date.now() / 1000) })
		this.queueChat(g.id)
		return g.id
	}
	async groupAction(chatId, action, payload = {}) {
		const sock = this.requireSock()
		const toJids = (list) => (list || []).map((p) => (p.includes('@') ? p : String(p).replace(/\D/g, '') + '@s.whatsapp.net'))
		switch (action) {
			case 'subject':
				await sock.groupUpdateSubject(chatId, payload.subject)
				break
			case 'description':
				await sock.groupUpdateDescription(chatId, payload.description || undefined)
				break
			case 'add':
			case 'remove':
			case 'promote':
			case 'demote': {
				const res = await sock.groupParticipantsUpdate(chatId, toJids(payload.participants), action)
				const failed = (res || []).filter((r) => r.status !== '200')
				if (failed.length) return { failed: failed.map((f) => ({ jid: f.jid, status: f.status })) }
				break
			}
			case 'invite':
				return { link: 'https://chat.whatsapp.com/' + (await sock.groupInviteCode(chatId)) }
			case 'revoke':
				return { link: 'https://chat.whatsapp.com/' + (await sock.groupRevokeInvite(chatId)) }
			case 'setting':
				await sock.groupSettingUpdate(chatId, payload.setting)
				break
			case 'photo':
				await sock.updateProfilePicture(chatId, Buffer.from(payload.photo))
				this.avatarCache.delete(chatId)
				break
			case 'leave':
				await sock.groupLeave(chatId)
				break
			default:
				throw new Error('Неизвестное действие')
		}
		return {}
	}
	async joinGroup(link) {
		const sock = this.requireSock()
		const code = String(link).trim().split('/').pop()
		return { chatId: await sock.groupAcceptInvite(code) }
	}

	// ================================================================ отложенные сообщения
	scheduleAdd(chatId, text, at) {
		if (!text?.trim()) throw new Error('Пустое сообщение')
		if (!(at > Date.now())) throw new Error('Время уже прошло')
		const id = this.store.addScheduled(chatId, text, at)
		this.emit('scheduled.update')
		return id
	}
	scheduleList(chatId) {
		return this.store
			.listScheduled()
			.filter((s) => !chatId || s.chat_id === chatId)
			.map((s) => ({ ...s, chatName: this.nameOf(s.chat_id) }))
	}
	scheduleCancel(id) {
		this.store.deleteScheduled(id)
		this.emit('scheduled.update')
	}
	async runScheduler() {
		if (!this.sock || this.state.connection !== 'open') return
		for (const s of this.store.dueScheduled(Date.now())) {
			this.store.setScheduled(s.id, 'sending')
			try {
				await this.sock.sendMessage(s.chat_id, { text: s.text })
				this.store.setScheduled(s.id, 'sent')
			} catch (err) {
				this.store.setScheduled(s.id, 'error', err.message)
			}
			this.emit('scheduled.update')
		}
	}

}

// перекодирование записи из браузера (webm/opus) в ogg/opus — формат голосовых WhatsApp
function toOggOpus(input) {
	return new Promise((resolve, reject) => {
		const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1'])
		const chunks = []
		let err = ''
		p.stdout.on('data', (c) => chunks.push(c))
		p.stderr.on('data', (c) => (err += c))
		p.on('error', () => reject(new Error('Для голосовых нужен ffmpeg (не найден в системе)')))
		p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('ffmpeg: ' + err))))
		p.stdin.on('error', () => {})
		p.stdin.end(input)
	})
}
