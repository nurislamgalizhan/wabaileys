// HTTP-сервер: веб-интерфейс, медиа, HTTP API, Socket.IO
import express from 'express'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'
import pino from 'pino'
import { Accounts } from './accounts.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '0.0.0.0'
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'))
const PASSWORD = process.env.APP_PASSWORD || ''
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

// ---------------------------------------------------------------- auth (опционально)
const SECRET = crypto.createHash('sha256').update('wa-web:' + PASSWORD + ':' + DATA_DIR).digest('hex')
const TOKEN = crypto.createHmac('sha256', SECRET).update('session').digest('hex')
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((p) => p.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]))
const authed = (cookieHeader) => !PASSWORD || parseCookies(cookieHeader).wa_auth === TOKEN
const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a)).digest(), crypto.createHash('sha256').update(String(b)).digest())

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))

app.post('/api/login', (req, res) => {
	const ok = PASSWORD && typeof req.body?.password === 'string' && sameSecret(req.body.password, PASSWORD)
	if (!ok) return res.status(401).json({ error: 'Неверный пароль' })
	res.setHeader('Set-Cookie', `wa_auth=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}`)
	res.json({ ok: true })
})
app.get('/api/auth', (req, res) => res.json({ required: !!PASSWORD, ok: authed(req.headers.cookie) }))

app.use(express.static(path.join(__dirname, '..', 'public')))
app.use('/vendor/socket.io', express.static(path.join(__dirname, '..', 'node_modules', 'socket.io', 'client-dist')))

const guard = (req, res, next) => (authed(req.headers.cookie) ? next() : res.status(401).end())

// ---------------------------------------------------------------- аккаунты
const accounts = new Accounts({ dataDir: DATA_DIR, logger })
const acc = (id) => accounts.get(accounts.has(id) ? id : accounts.ids()[0])

app.get('/media/:acc/:chatId/:msgId', guard, async (req, res) => {
	try {
		const { file, mimetype, fileName } = await acc(req.params.acc).getMedia(req.params.chatId, req.params.msgId)
		res.setHeader('Content-Type', mimetype)
		res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
		if (req.query.download) res.attachment(fileName || path.basename(file))
		res.sendFile(file)
	} catch (err) {
		logger.warn({ err: err.message }, 'media download failed')
		res.status(404).send(err.message)
	}
})

app.get('/avatar/:acc/:jid', guard, async (req, res) => {
	const url = await acc(req.params.acc).getAvatar(req.params.jid)
	if (!url) return res.status(404).end()
	try {
		const r = await fetch(url)
		if (!r.ok) throw new Error(String(r.status))
		res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg')
		res.setHeader('Cache-Control', 'private, max-age=3600')
		res.end(Buffer.from(await r.arrayBuffer()))
	} catch {
		res.status(404).end()
	}
})

// ---------------------------------------------------------------- HTTP API (Bearer-токен)
const api = express.Router()
api.use((req, res, next) => {
	const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
	if (!token || !sameSecret(token, accounts.apiToken)) return res.status(401).json({ error: 'unauthorized' })
	next()
})
const apiAcc = (req, res) => {
	if (!accounts.has(req.params.acc)) {
		res.status(404).json({ error: 'account not found' })
		return null
	}
	return accounts.get(req.params.acc)
}
const toJid = (to) => (String(to).includes('@') ? String(to) : String(to).replace(/\D/g, '') + '@s.whatsapp.net')
api.get('/accounts', (req, res) => res.json(accounts.summary()))
api.get('/:acc/chats', (req, res) => {
	const wa = apiAcc(req, res)
	if (wa) res.json(wa.listChats())
})
api.get('/:acc/chats/:chatId/messages', (req, res) => {
	const wa = apiAcc(req, res)
	if (wa) res.json(wa.listMessages(req.params.chatId, Number(req.query.before) || undefined, Math.min(Number(req.query.limit) || 50, 200)))
})
api.get('/:acc/search', (req, res) => {
	const wa = apiAcc(req, res)
	if (wa) res.json(wa.search(req.query.q || '').map((r) => ({ ...r, snippet: r.snippet.replace(/[\u0001\u0002]/g, '') })))
})
api.post('/:acc/messages', async (req, res) => {
	const wa = apiAcc(req, res)
	if (!wa) return
	try {
		const { to, text, at } = req.body || {}
		if (!to || !text) return res.status(400).json({ error: 'to and text are required' })
		if (at) return res.json({ scheduled: wa.scheduleAdd(toJid(to), String(text), new Date(at).getTime()) })
		await wa.sendText(toJid(to), String(text))
		res.json({ ok: true })
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})
app.use('/api/v1', api)

// ---------------------------------------------------------------- Socket.IO
const server = http.createServer(app)
const io = new Server(server, { maxHttpBufferSize: 100 * 1024 * 1024 })

io.use((socket, next) => (authed(socket.handshake.headers.cookie) ? next() : next(new Error('unauthorized'))))

accounts.on('event', (id, ev, payload) => io.to('acc:' + id).emit(ev, payload))
accounts.on('summary', (list) => io.emit('accounts', list))

// обёртка: (data, ack) => ack({ ok, ...result } | { error })
const handle = (fn) => async (data, ack) => {
	try {
		const r = await fn(data || {})
		if (typeof ack === 'function') ack({ ok: true, ...(r && typeof r === 'object' && !Array.isArray(r) ? r : { result: r }) })
	} catch (err) {
		logger.warn({ err: err.message }, 'socket handler error')
		if (typeof ack === 'function') ack({ error: err.message || String(err) })
	}
}

io.on('connection', (socket) => {
	let current = null
	const wa = () => accounts.get(current)
	const select = (id) => {
		const next = accounts.has(id) ? id : accounts.ids()[0]
		if (current === next) return
		if (current) {
			socket.leave('acc:' + current)
			accounts.get(current).setClient(socket.id, null)
		}
		current = next
		socket.join('acc:' + current)
		const w = wa()
		w.setClient(socket.id, { visible: false, chatId: null })
		socket.emit('account', { id: current })
		socket.emit('state', w.publicState())
	}
	select(socket.handshake.auth?.account)
	socket.emit('accounts', accounts.summary())

	const on = (ev, fn) => socket.on(ev, handle(fn))

	// ---- аккаунты
	on('account.select', ({ id }) => select(id))
	on('account.add', ({ label }) => {
		const id = accounts.add(label)
		select(id)
		return { id }
	})
	on('account.rename', ({ id, label }) => accounts.rename(id, label))
	on('account.remove', async ({ id }) => {
		if (current === id) {
			const other = accounts.ids().find((x) => x !== id)
			select(other)
		}
		await accounts.remove(id)
	})
	on('api.info', () => ({ token: accounts.apiToken }))
	on('api.regenerate', () => ({ token: accounts.regenerateToken() }))

	// ---- вход
	on('login.qr', async () => {
		const w = wa()
		if (w.sock && w.state.connection === 'qr') return
		await w.stop()
		await w.start()
	})
	on('login.code', async ({ phone }) => ({ code: await wa().loginWithCode(phone) }))
	on('logout', () => wa().logout())

	// ---- чтение
	on('chats.list', () => ({ chats: wa().listChats() }))
	on('messages.list', ({ chatId, before, after, limit }) => wa().listMessages(chatId, before, Math.min(limit || 50, 200), after))
	on('messages.around', ({ chatId, id }) => wa().messagesAround(chatId, id))
	on('search', ({ query }) => ({ results: wa().search(query) }))
	on('starred.list', () => ({ messages: wa().listStarred() }))
	on('group.info', async ({ chatId }) => ({ group: await wa().groupInfo(chatId) }))
	on('contact.info', async ({ jid }) => ({ contact: await wa().contactInfo(jid) }))
	on('contacts.list', () => ({ contacts: wa().listContacts() }))
	on('numbers.check', async ({ phones }) => ({ results: await wa().checkNumbers(phones || []) }))
	on('statuses.list', () => ({ statuses: wa().listStatuses() }))
	on('status.view', ({ id }) => wa().viewStatus(id))
	on('calls.list', () => ({ calls: wa().listCalls() }))

	// ---- присутствие и прочтение
	socket.on('client.state', ({ chatId, visible } = {}) => {
		if (!current) return
		wa().setClient(socket.id, { chatId: chatId || null, visible: !!visible })
		if (chatId && visible) wa().subscribePresence(chatId)
	})
	on('settings.set', (s) => ({ settings: wa().updateSettings(s) }))
	on('chat.read', ({ chatId }) => wa().markRead(chatId, true))
	on('chat.unread', ({ chatId }) => wa().markUnread(chatId))
	on('message.played', ({ chatId, msgId }) => wa().markPlayed(chatId, msgId))
	on('typing', ({ chatId, composing }) => wa().typing(chatId, composing))

	// ---- отправка и действия с сообщениями
	on('message.send', ({ chatId, text, quotedId }) => wa().sendText(chatId, String(text || '').slice(0, 65536), quotedId))
	on('message.media', (d) => wa().sendMedia(d.chatId, d))
	on('message.react', ({ chatId, msgId, emoji }) => wa().react(chatId, msgId, emoji))
	on('message.delete', ({ chatId, msgId }) => wa().deleteForAll(chatId, msgId))
	on('message.deleteForMe', ({ chatId, msgId }) => wa().deleteForMe(chatId, msgId))
	on('message.edit', ({ chatId, msgId, text }) => wa().editMessage(chatId, msgId, String(text || '')))
	on('message.forward', ({ chatId, msgId, to }) => wa().forwardMessage(chatId, msgId, to || []))
	on('message.star', ({ chatId, msgId, star }) => wa().starMessage(chatId, msgId, star))

	// ---- чаты, профиль, приватность, группы
	on('chat.action', ({ chatId, action, value }) => wa().chatAction(chatId, action, value))
	on('profile.get', async () => ({ profile: await wa().getProfile() }))
	on('profile.set', (d) => wa().setProfile(d))
	on('privacy.set', ({ key, value }) => wa().setPrivacy(key, value))
	on('group.create', async ({ subject, participants }) => ({ chatId: await wa().createGroup(subject, participants || []) }))
	on('group.action', ({ chatId, action, payload }) => wa().groupAction(chatId, action, payload))
	on('group.join', ({ link }) => wa().joinGroup(link))

	// ---- отложенные и автоответчик
	on('schedule.add', ({ chatId, text, at }) => ({ id: wa().scheduleAdd(chatId, text, at) }))
	on('schedule.list', ({ chatId }) => ({ items: wa().scheduleList(chatId) }))
	on('schedule.cancel', ({ id }) => wa().scheduleCancel(id))
	on('rules.list', () => ({ rules: wa().store.rules(), log: wa().botLog || [] }))
	on('rules.save', ({ rule }) => {
		const id = wa().store.saveRule(rule)
		return { id }
	})
	on('rules.delete', ({ id }) => wa().store.deleteRule(id))

	socket.on('disconnect', () => {
		if (current) accounts.get(current).setClient(socket.id, null)
	})
})

server.listen(PORT, HOST, () => {
	logger.info(`WA Web: http://localhost:${PORT}${PASSWORD ? ' (защищено паролем)' : ''}`)
	accounts.startAll()
})

const shutdown = async () => {
	await accounts.stopAll()
	process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
