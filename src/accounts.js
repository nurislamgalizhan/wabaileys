// Несколько аккаунтов WhatsApp в одном сервере
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { WhatsApp } from './wa.js'
import { attachBot } from './bot.js'

// события аккаунта, которые пересылаются в браузер
export const FORWARDED = [
	'state', 'chats.update', 'chat.removed', 'chat.history', 'chat.cleared', 'message.new', 'message.update',
	'message.delete', 'presence', 'reset', 'status.new', 'call', 'scheduled.update', 'bot.log'
]

export class Accounts extends EventEmitter {
	constructor({ dataDir, logger }) {
		super()
		this.dataDir = dataDir
		this.logger = logger
		this.file = path.join(dataDir, 'accounts.json')
		fs.mkdirSync(dataDir, { recursive: true })
		this.config = this.load()
		this.instances = new Map()
		this.summaryTimer = null
		// отложенные сообщения: проверка раз в 10 секунд
		this.timer = setInterval(() => {
			for (const wa of this.instances.values()) wa.runScheduler().catch((err) => logger.warn({ err }, 'scheduler failed'))
		}, 10_000)
	}

	load() {
		try {
			const c = JSON.parse(fs.readFileSync(this.file, 'utf8'))
			if (Array.isArray(c.accounts) && c.accounts.length) return c
		} catch {}
		// аккаунт «main» хранится прямо в DATA_DIR — совместимость с первой версией
		const c = { accounts: [{ id: 'main', label: '' }], apiToken: crypto.randomBytes(24).toString('hex') }
		fs.writeFileSync(this.file, JSON.stringify(c, null, 2))
		return c
	}
	save() {
		fs.writeFileSync(this.file, JSON.stringify(this.config, null, 2))
	}
	get apiToken() {
		return this.config.apiToken
	}
	regenerateToken() {
		this.config.apiToken = crypto.randomBytes(24).toString('hex')
		this.save()
		return this.config.apiToken
	}

	dirFor(id) {
		return id === 'main' ? this.dataDir : path.join(this.dataDir, 'accounts', id)
	}
	has(id) {
		return this.config.accounts.some((a) => a.id === id)
	}
	ids() {
		return this.config.accounts.map((a) => a.id)
	}
	get(id) {
		if (!this.has(id)) throw new Error('Аккаунт не найден')
		let wa = this.instances.get(id)
		if (wa) return wa
		wa = new WhatsApp({ dataDir: this.dirFor(id), logger: this.logger.child({ account: id }) })
		wa.webhookSecret = () => this.config.apiToken
		attachBot(wa, { accountId: id })
		for (const ev of FORWARDED) wa.on(ev, (payload) => this.emit('event', id, ev, payload))
		for (const ev of ['state', 'chats.update', 'reset']) wa.on(ev, () => this.queueSummary())
		this.instances.set(id, wa)
		return wa
	}

	summary() {
		return this.config.accounts.map((a) => {
			const wa = this.get(a.id)
			let unread = 0
			for (const c of wa.store.allChats()) if (c.unread > 0 && !c.archived && !(c.muted > Date.now() / 1000 || c.muted === -1)) unread++
			return { id: a.id, label: a.label, me: wa.state.me, connection: wa.state.connection, unread }
		})
	}
	queueSummary() {
		clearTimeout(this.summaryTimer)
		this.summaryTimer = setTimeout(() => this.emit('summary', this.summary()), 500)
	}

	add(label = '') {
		const id = 'acc' + crypto.randomBytes(4).toString('hex')
		this.config.accounts.push({ id, label: String(label).slice(0, 40) })
		this.save()
		this.queueSummary()
		return id
	}
	rename(id, label) {
		const a = this.config.accounts.find((x) => x.id === id)
		if (!a) throw new Error('Аккаунт не найден')
		a.label = String(label || '').slice(0, 40)
		this.save()
		this.queueSummary()
	}
	async remove(id) {
		if (this.config.accounts.length <= 1) throw new Error('Нельзя удалить единственный аккаунт')
		const wa = this.get(id)
		await wa.logout().catch(() => {})
		wa.close()
		this.instances.delete(id)
		this.config.accounts = this.config.accounts.filter((a) => a.id !== id)
		this.save()
		if (id !== 'main') fs.rmSync(this.dirFor(id), { recursive: true, force: true })
		this.queueSummary()
	}
	startAll() {
		for (const id of this.ids()) {
			const wa = this.get(id)
			if (wa.isRegistered()) wa.start().catch((err) => this.logger.error({ err, account: id }, 'start failed'))
		}
	}
	async stopAll() {
		clearInterval(this.timer)
		for (const wa of this.instances.values()) await wa.stop()
	}
}
