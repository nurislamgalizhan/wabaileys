// HTTP-сервер: веб-интерфейс, медиа, Socket.IO
import express from 'express'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Server } from 'socket.io'
import pino from 'pino'
import { WhatsApp } from './wa.js'

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

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

app.post('/api/login', (req, res) => {
	const ok = PASSWORD && typeof req.body?.password === 'string' && crypto.timingSafeEqual(crypto.createHash('sha256').update(req.body.password).digest(), crypto.createHash('sha256').update(PASSWORD).digest())
	if (!ok) return res.status(401).json({ error: 'Неверный пароль' })
	res.setHeader('Set-Cookie', `wa_auth=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}`)
	res.json({ ok: true })
})
app.get('/api/auth', (req, res) => res.json({ required: !!PASSWORD, ok: authed(req.headers.cookie) }))

app.use(express.static(path.join(__dirname, '..', 'public')))
app.use('/vendor/socket.io', express.static(path.join(__dirname, '..', 'node_modules', 'socket.io', 'client-dist')))

const guard = (req, res, next) => (authed(req.headers.cookie) ? next() : res.status(401).end())

// ---------------------------------------------------------------- WhatsApp
const wa = new WhatsApp({ dataDir: DATA_DIR, logger })

app.get('/media/:chatId/:msgId', guard, async (req, res) => {
	try {
		const { file, mimetype, fileName } = await wa.getMedia(req.params.chatId, req.params.msgId)
		res.setHeader('Content-Type', mimetype)
		res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
		if (req.query.download) res.attachment(fileName || path.basename(file))
		res.sendFile(file)
	} catch (err) {
		logger.warn({ err: err.message }, 'media download failed')
		res.status(404).send(err.message)
	}
})

app.get('/avatar/:jid', guard, async (req, res) => {
	const url = await wa.getAvatar(req.params.jid)
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

// ---------------------------------------------------------------- Socket.IO
const server = http.createServer(app)
const io = new Server(server, { maxHttpBufferSize: 100 * 1024 * 1024 })

io.use((socket, next) => (authed(socket.handshake.headers.cookie) ? next() : next(new Error('unauthorized'))))

wa.on('state', (s) => io.emit('state', s))
wa.on('chats.update', (list) => io.emit('chats.update', list))
wa.on('chat.removed', (id) => io.emit('chat.removed', id))
wa.on('chat.history', (id) => io.emit('chat.history', id))
wa.on('message.new', (m) => io.emit('message.new', m))
wa.on('message.update', (m) => io.emit('message.update', m))
wa.on('message.delete', (m) => io.emit('message.delete', m))
wa.on('presence', (p) => io.emit('presence', p))
wa.on('reset', () => io.emit('reset'))

// обёртка: (data, ack) => ack({ ok, ...result } | { error })
const handle = (fn) => async (data, ack) => {
	try {
		const r = await fn(data || {})
		if (typeof ack === 'function') ack({ ok: true, ...(r && typeof r === 'object' ? r : { result: r }) })
	} catch (err) {
		logger.warn({ err: err.message }, 'socket handler error')
		if (typeof ack === 'function') ack({ error: err.message || String(err) })
	}
}

io.on('connection', (socket) => {
	socket.emit('state', wa.publicState())
	wa.setClient(socket.id, { visible: false, chatId: null })

	socket.on('login.qr', handle(async () => {
		if (wa.sock && wa.state.connection === 'qr') return
		await wa.stop()
		await wa.start()
	}))
	socket.on('login.code', handle(async ({ phone }) => ({ code: await wa.loginWithCode(phone) })))
	socket.on('logout', handle(() => wa.logout()))

	socket.on('chats.list', handle(() => ({ chats: wa.listChats() })))
	socket.on('messages.list', handle(({ chatId, before, limit }) => wa.listMessages(chatId, before, Math.min(limit || 50, 200))))
	socket.on('group.info', handle(async ({ chatId }) => ({ group: await wa.groupInfo(chatId) })))

	socket.on('client.state', ({ chatId, visible } = {}) => {
		wa.setClient(socket.id, { chatId: chatId || null, visible: !!visible })
		if (chatId && visible) wa.subscribePresence(chatId)
	})
	socket.on('settings.set', handle((s) => ({ settings: wa.updateSettings(s) })))

	socket.on('chat.read', handle(({ chatId }) => wa.markRead(chatId, true)))
	socket.on('chat.unread', handle(({ chatId }) => wa.markUnread(chatId)))
	socket.on('message.played', handle(({ chatId, msgId }) => wa.markPlayed(chatId, msgId)))
	socket.on('typing', handle(({ chatId, composing }) => wa.typing(chatId, composing)))

	socket.on('message.send', handle(({ chatId, text, quotedId }) => wa.sendText(chatId, String(text || '').slice(0, 65536), quotedId)))
	socket.on('message.media', handle((d) => wa.sendMedia(d.chatId, d)))
	socket.on('message.react', handle(({ chatId, msgId, emoji }) => wa.react(chatId, msgId, emoji)))
	socket.on('message.delete', handle(({ chatId, msgId }) => wa.deleteForAll(chatId, msgId)))

	socket.on('disconnect', () => wa.setClient(socket.id, null))
})

server.listen(PORT, HOST, () => {
	logger.info(`WhatsApp Web clone: http://localhost:${PORT}${PASSWORD ? ' (защищено паролем)' : ''}`)
	if (wa.isRegistered()) wa.start().catch((err) => logger.error({ err }, 'start failed'))
})

const shutdown = async () => {
	await wa.stop()
	process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
