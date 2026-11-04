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
import { Store } from './db.js'
import { msgTimestamp, previewText, serializeContent, unwrap } from './serialize.js'

const DEFAULT_SETTINGS = { online: false, readReceipts: false, deviceName: '' }

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
	}

	// ---------------------------------------------------------------- state
	setState(patch) {
		Object.assign(this.state, patch)
		this.emit('state', this.publicState())
	}
	publicState() {
		return { ...this.state, settings: this.settings }
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
	listMessages(chatId, before, limit = 50) {
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
		if ('muteEndTime' in chat) patch.muted = chat.muteEndTime ? toNumber(chat.muteEndTime) : 0
		if ('mute' in chat) patch.muted = chat.mute ? toNumber(chat.mute) : 0
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
		if (isJidStatusBroadcast(key.remoteJid) || isJidNewsletter(key.remoteJid) || key.remoteJid.endsWith('@broadcast')) return null
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
			if (existing._readSent) msg._readSent = true
		}
		const ts = msgTimestamp(msg)
		this.store.putMessage(chatId, msg, ts)

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
				const dto = this.messageDTO(r.chatId, r.msg)
				if (dto) this.emit(r.isNew ? 'message.new' : 'message.update', dto)
				if (r.isNew && !m.key.fromMe && type === 'notify') this.autoRead(r.chatId)
			}
		})

		ev.on('messages.update', (updates) => {
			for (const { key, update } of updates) {
				const chatId = this.norm(key.remoteJid, key.remoteJidAlt)
				const msg = this.store.getMessage(chatId, key.id)
				if (!msg) continue
				if (update.message === null || update.messageStubType === WAMessageStubType.REVOKE) {
					msg.message = null
					msg.messageStubType = WAMessageStubType.REVOKE
				} else if (update.message?.editedMessage?.message) {
					msg.message = update.message.editedMessage.message
					msg._edited = true
				}
				if (update.status != null) msg.status = Math.max(msg.status || 0, update.status)
				if (update.starred != null) msg.starred = update.starred
				this.store.putMessage(chatId, msg, msgTimestamp(msg))
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
		for (const k of ['online', 'readReceipts']) if (typeof patch[k] === 'boolean') this.settings[k] = patch[k]
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
