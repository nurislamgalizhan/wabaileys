// Локальное хранилище на встроенном SQLite (node:sqlite, Node.js >= 22.13)
import { DatabaseSync } from 'node:sqlite'
import { BufferJSON } from 'baileys'
import fs from 'node:fs'
import path from 'node:path'

const enc = (v) => JSON.stringify(v, BufferJSON.replacer)
const dec = (s) => (s ? JSON.parse(s, BufferJSON.reviver) : undefined)

export class Store {
	constructor(dir) {
		fs.mkdirSync(dir, { recursive: true })
		this.db = new DatabaseSync(path.join(dir, 'store.db'))
		this.db.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = NORMAL;
			CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
			CREATE TABLE IF NOT EXISTS chats (
				id TEXT PRIMARY KEY, name TEXT, unread INTEGER DEFAULT 0, ts INTEGER DEFAULT 0,
				archived INTEGER DEFAULT 0, pinned INTEGER DEFAULT 0, muted INTEGER DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS messages (
				chat_id TEXT NOT NULL, id TEXT NOT NULL, from_me INTEGER, ts INTEGER, data TEXT,
				PRIMARY KEY (chat_id, id)
			);
			CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages (chat_id, ts);
			CREATE TABLE IF NOT EXISTS reactions (
				chat_id TEXT, msg_id TEXT, sender TEXT, text TEXT, ts INTEGER,
				PRIMARY KEY (chat_id, msg_id, sender)
			);
			CREATE TABLE IF NOT EXISTS contacts (
				id TEXT PRIMARY KEY, name TEXT, notify TEXT, verified TEXT
			);
			CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, subject TEXT, data TEXT);
			CREATE TABLE IF NOT EXISTS lidmap (lid TEXT PRIMARY KEY, pn TEXT);
		`)
		this.lidToPn = new Map()
		for (const r of this.db.prepare('SELECT lid, pn FROM lidmap').all()) this.lidToPn.set(r.lid, r.pn)
		this.s = {
			kvGet: this.db.prepare('SELECT v FROM kv WHERE k = ?'),
			kvSet: this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
			chatGet: this.db.prepare('SELECT * FROM chats WHERE id = ?'),
			chatAll: this.db.prepare('SELECT * FROM chats ORDER BY pinned DESC, ts DESC'),
			chatUpsert: this.db.prepare(`INSERT INTO chats (id, name, unread, ts, archived, pinned, muted)
				VALUES ($id, $name, $unread, $ts, $archived, $pinned, $muted)
				ON CONFLICT(id) DO UPDATE SET name = excluded.name, unread = excluded.unread, ts = excluded.ts,
				archived = excluded.archived, pinned = excluded.pinned, muted = excluded.muted`),
			chatDel: this.db.prepare('DELETE FROM chats WHERE id = ?'),
			msgGet: this.db.prepare('SELECT data FROM messages WHERE chat_id = ? AND id = ?'),
			msgGetAny: this.db.prepare('SELECT data FROM messages WHERE id = ? LIMIT 1'),
			msgUpsert: this.db.prepare(`INSERT INTO messages (chat_id, id, from_me, ts, data) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(chat_id, id) DO UPDATE SET data = excluded.data, ts = excluded.ts`),
			msgPage: this.db.prepare('SELECT data FROM messages WHERE chat_id = ? AND ts <= ? ORDER BY ts DESC LIMIT ?'),
			msgLast: this.db.prepare('SELECT data FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT 1'),
			msgOldest: this.db.prepare('SELECT data FROM messages WHERE chat_id = ? ORDER BY ts ASC LIMIT 1'),
			msgUnreadIncoming: this.db.prepare('SELECT data FROM messages WHERE chat_id = ? AND from_me = 0 ORDER BY ts DESC LIMIT ?'),
			msgDelChat: this.db.prepare('DELETE FROM messages WHERE chat_id = ?'),
			msgDel: this.db.prepare('DELETE FROM messages WHERE chat_id = ? AND id = ?'),
			reactSet: this.db.prepare(`INSERT INTO reactions (chat_id, msg_id, sender, text, ts) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(chat_id, msg_id, sender) DO UPDATE SET text = excluded.text, ts = excluded.ts`),
			reactDel: this.db.prepare('DELETE FROM reactions WHERE chat_id = ? AND msg_id = ? AND sender = ?'),
			reactFor: this.db.prepare('SELECT sender, text FROM reactions WHERE chat_id = ? AND msg_id = ?'),
			contactGet: this.db.prepare('SELECT * FROM contacts WHERE id = ?'),
			contactUpsert: this.db.prepare(`INSERT INTO contacts (id, name, notify, verified) VALUES ($id, $name, $notify, $verified)
				ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, contacts.name),
				notify = COALESCE(excluded.notify, contacts.notify), verified = COALESCE(excluded.verified, contacts.verified)`),
			groupGet: this.db.prepare('SELECT data FROM groups WHERE id = ?'),
			groupUpsert: this.db.prepare(`INSERT INTO groups (id, subject, data) VALUES (?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, data = excluded.data`),
			lidSet: this.db.prepare('INSERT INTO lidmap (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn')
		}
	}

	tx(fn) {
		// вложенные вызовы выполняются внутри внешней транзакции
		if (this.depth) return fn()
		this.depth = 1
		this.db.exec('BEGIN')
		try {
			const r = fn()
			this.db.exec('COMMIT')
			return r
		} catch (e) {
			this.db.exec('ROLLBACK')
			throw e
		} finally {
			this.depth = 0
		}
	}

	// ---- key/value ----
	get(k, def) {
		const r = this.s.kvGet.get(k)
		return r ? JSON.parse(r.v) : def
	}
	set(k, v) {
		this.s.kvSet.run(k, JSON.stringify(v))
	}

	// ---- LID <-> PN ----
	setLid(lid, pn) {
		if (!lid || !pn || this.lidToPn.get(lid) === pn) return false
		this.lidToPn.set(lid, pn)
		this.s.lidSet.run(lid, pn)
		return true
	}

	// ---- chats ----
	getChat(id) {
		return this.s.chatGet.get(id)
	}
	allChats() {
		return this.s.chatAll.all()
	}
	upsertChat(c) {
		const cur = this.getChat(c.id) || { id: c.id, name: null, unread: 0, ts: 0, archived: 0, pinned: 0, muted: 0 }
		const next = { ...cur, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) }
		this.s.chatUpsert.run({
			$id: next.id, $name: next.name ?? null, $unread: next.unread | 0, $ts: next.ts | 0,
			$archived: next.archived ? 1 : 0, $pinned: next.pinned | 0, $muted: next.muted | 0
		})
		return next
	}
	deleteChat(id) {
		this.s.chatDel.run(id)
		this.s.msgDelChat.run(id)
	}
	// перенос чата с LID-идентификатора на номер телефона
	mergeChat(fromId, toId) {
		const from = this.getChat(fromId)
		if (!from) return false
		this.tx(() => {
			const to = this.getChat(toId)
			this.db.prepare('UPDATE OR IGNORE messages SET chat_id = ? WHERE chat_id = ?').run(toId, fromId)
			this.db.prepare('UPDATE OR IGNORE reactions SET chat_id = ? WHERE chat_id = ?').run(toId, fromId)
			this.s.msgDelChat.run(fromId)
			this.s.chatDel.run(fromId)
			this.upsertChat({
				id: toId,
				name: to?.name || from.name,
				unread: (to?.unread || 0) + (from.unread || 0),
				ts: Math.max(to?.ts || 0, from.ts || 0),
				archived: to ? to.archived : from.archived,
				pinned: Math.max(to?.pinned || 0, from.pinned || 0),
				muted: Math.max(to?.muted || 0, from.muted || 0)
			})
		})
		return true
	}

	// ---- messages ----
	getMessage(chatId, id) {
		return dec(this.s.msgGet.get(chatId, id)?.data)
	}
	findMessage(id) {
		return dec(this.s.msgGetAny.get(id)?.data)
	}
	putMessage(chatId, msg, ts) {
		this.s.msgUpsert.run(chatId, msg.key.id, msg.key.fromMe ? 1 : 0, ts, enc(msg))
	}
	deleteMessage(chatId, id) {
		this.s.msgDel.run(chatId, id)
	}
	pageMessages(chatId, before, limit) {
		return this.s.msgPage.all(chatId, before, limit).map((r) => dec(r.data)).reverse()
	}
	lastMessage(chatId) {
		return dec(this.s.msgLast.get(chatId)?.data)
	}
	oldestMessage(chatId) {
		return dec(this.s.msgOldest.get(chatId)?.data)
	}
	recentIncoming(chatId, limit) {
		return this.s.msgUnreadIncoming.all(chatId, limit).map((r) => dec(r.data))
	}

	// ---- reactions ----
	setReaction(chatId, msgId, sender, text, ts) {
		if (text) this.s.reactSet.run(chatId, msgId, sender, text, ts | 0)
		else this.s.reactDel.run(chatId, msgId, sender)
	}
	reactions(chatId, msgId) {
		return this.s.reactFor.all(chatId, msgId)
	}

	// ---- contacts / groups ----
	getContact(id) {
		return this.s.contactGet.get(id)
	}
	upsertContact(c) {
		this.s.contactUpsert.run({ $id: c.id, $name: c.name || null, $notify: c.notify || null, $verified: c.verified || null })
	}
	getGroup(id) {
		return dec(this.s.groupGet.get(id)?.data)
	}
	upsertGroup(g) {
		const cur = this.getGroup(g.id) || {}
		const next = { ...cur, ...g }
		this.s.groupUpsert.run(g.id, next.subject || null, enc(next))
		return next
	}

	clearAll() {
		this.db.exec('DELETE FROM chats; DELETE FROM messages; DELETE FROM reactions; DELETE FROM contacts; DELETE FROM groups; DELETE FROM lidmap;')
		this.lidToPn.clear()
	}
}
