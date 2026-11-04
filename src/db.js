// Локальное хранилище на встроенном SQLite (node:sqlite, Node.js >= 22.13)
import { DatabaseSync } from 'node:sqlite'
import { BufferJSON } from 'baileys'
import fs from 'node:fs'
import path from 'node:path'

const enc = (v) => JSON.stringify(v, BufferJSON.replacer)
const dec = (s) => (s ? JSON.parse(s, BufferJSON.reviver) : undefined)
export const STATUS_JID = 'status@broadcast'
const yo = (t) => t.replace(/ё/g, 'е').replace(/Ё/g, 'Е') // «отчет» находит «отчёт»

export class Store {
	constructor(dir) {
		fs.mkdirSync(dir, { recursive: true })
		this.db = new DatabaseSync(path.join(dir, 'store.db'))
		this.depth = 0
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
			CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
				text, chat_id UNINDEXED, msg_id UNINDEXED, ts UNINDEXED, tokenize = 'unicode61 remove_diacritics 2'
			);
			CREATE TABLE IF NOT EXISTS scheduled (
				id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, text TEXT, at INTEGER,
				status TEXT DEFAULT 'pending', error TEXT, created INTEGER
			);
			CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY AUTOINCREMENT, pos INTEGER DEFAULT 0, data TEXT);
			CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, data TEXT, ts INTEGER);
		`)
		this.lidToPn = new Map()
		for (const r of this.db.prepare('SELECT lid, pn FROM lidmap').all()) this.lidToPn.set(r.lid, r.pn)
		const p = (sql) => this.db.prepare(sql)
		this.s = {
			kvGet: p('SELECT v FROM kv WHERE k = ?'),
			kvSet: p('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
			chatGet: p('SELECT * FROM chats WHERE id = ?'),
			chatAll: p('SELECT * FROM chats ORDER BY pinned DESC, ts DESC'),
			chatUpsert: p(`INSERT INTO chats (id, name, unread, ts, archived, pinned, muted)
				VALUES ($id, $name, $unread, $ts, $archived, $pinned, $muted)
				ON CONFLICT(id) DO UPDATE SET name = excluded.name, unread = excluded.unread, ts = excluded.ts,
				archived = excluded.archived, pinned = excluded.pinned, muted = excluded.muted`),
			chatDel: p('DELETE FROM chats WHERE id = ?'),
			msgGet: p('SELECT data FROM messages WHERE chat_id = ? AND id = ?'),
			msgGetAny: p('SELECT data FROM messages WHERE id = ? LIMIT 1'),
			msgUpsert: p(`INSERT INTO messages (chat_id, id, from_me, ts, data) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(chat_id, id) DO UPDATE SET data = excluded.data, ts = excluded.ts`),
			msgRowid: p('SELECT rowid FROM messages WHERE chat_id = ? AND id = ?'),
			msgPage: p('SELECT data FROM messages WHERE chat_id = ? AND ts <= ? ORDER BY ts DESC LIMIT ?'),
			msgAfter: p('SELECT data FROM messages WHERE chat_id = ? AND ts >= ? ORDER BY ts ASC LIMIT ?'),
			msgLast: p('SELECT data FROM messages WHERE chat_id = ? ORDER BY ts DESC LIMIT 1'),
			msgOldest: p('SELECT data FROM messages WHERE chat_id = ? ORDER BY ts ASC LIMIT 1'),
			msgUnreadIncoming: p('SELECT data FROM messages WHERE chat_id = ? AND from_me = 0 ORDER BY ts DESC LIMIT ?'),
			msgSince: p('SELECT data FROM messages WHERE chat_id = ? AND ts >= ? ORDER BY ts ASC'),
			msgDelChat: p('DELETE FROM messages WHERE chat_id = ?'),
			msgDel: p('DELETE FROM messages WHERE chat_id = ? AND id = ?'),
			msgDelOlder: p('DELETE FROM messages WHERE chat_id = ? AND ts < ?'),
			ftsDel: p('DELETE FROM msg_fts WHERE rowid = ?'),
			ftsIns: p('INSERT INTO msg_fts (rowid, text, chat_id, msg_id, ts) VALUES (?, ?, ?, ?, ?)'),
			ftsDelChat: p('DELETE FROM msg_fts WHERE chat_id = ?'),
			ftsSearch: p(`SELECT chat_id, msg_id, ts, snippet(msg_fts, 0, '\u0001', '\u0002', '…', 12) AS snip
				FROM msg_fts WHERE msg_fts MATCH ? ORDER BY ts DESC LIMIT ?`),
			reactSet: p(`INSERT INTO reactions (chat_id, msg_id, sender, text, ts) VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(chat_id, msg_id, sender) DO UPDATE SET text = excluded.text, ts = excluded.ts`),
			reactDel: p('DELETE FROM reactions WHERE chat_id = ? AND msg_id = ? AND sender = ?'),
			reactFor: p('SELECT sender, text FROM reactions WHERE chat_id = ? AND msg_id = ?'),
			contactGet: p('SELECT * FROM contacts WHERE id = ?'),
			contactAll: p("SELECT * FROM contacts WHERE id LIKE '%@s.whatsapp.net' AND (name IS NOT NULL OR notify IS NOT NULL)"),
			contactUpsert: p(`INSERT INTO contacts (id, name, notify, verified) VALUES ($id, $name, $notify, $verified)
				ON CONFLICT(id) DO UPDATE SET name = COALESCE(excluded.name, contacts.name),
				notify = COALESCE(excluded.notify, contacts.notify), verified = COALESCE(excluded.verified, contacts.verified)`),
			groupGet: p('SELECT data FROM groups WHERE id = ?'),
			groupUpsert: p(`INSERT INTO groups (id, subject, data) VALUES (?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, data = excluded.data`),
			lidSet: p('INSERT INTO lidmap (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn'),
			schedAdd: p("INSERT INTO scheduled (chat_id, text, at, status, created) VALUES (?, ?, ?, 'pending', ?)"),
			schedList: p('SELECT * FROM scheduled ORDER BY at ASC'),
			schedDue: p("SELECT * FROM scheduled WHERE status = 'pending' AND at <= ? ORDER BY at ASC LIMIT 20"),
			schedGet: p('SELECT * FROM scheduled WHERE id = ?'),
			schedSet: p('UPDATE scheduled SET status = ?, error = ? WHERE id = ?'),
			schedDel: p('DELETE FROM scheduled WHERE id = ?'),
			ruleAll: p('SELECT id, data FROM rules ORDER BY pos, id'),
			ruleIns: p('INSERT INTO rules (pos, data) VALUES (?, ?)'),
			ruleUpd: p('UPDATE rules SET data = ? WHERE id = ?'),
			ruleDel: p('DELETE FROM rules WHERE id = ?'),
			callSet: p('INSERT INTO calls (id, data, ts) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
			callList: p('SELECT data FROM calls ORDER BY ts DESC LIMIT 100')
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
		this.s.ftsDelChat.run(id)
	}
	// перенос чата с LID-идентификатора на номер телефона
	mergeChat(fromId, toId) {
		const from = this.getChat(fromId)
		if (!from) return false
		this.tx(() => {
			const to = this.getChat(toId)
			this.db.prepare('UPDATE OR IGNORE messages SET chat_id = ? WHERE chat_id = ?').run(toId, fromId)
			this.db.prepare('UPDATE OR IGNORE reactions SET chat_id = ? WHERE chat_id = ?').run(toId, fromId)
			this.db.prepare('UPDATE msg_fts SET chat_id = ? WHERE chat_id = ?').run(toId, fromId)
			this.db.prepare('UPDATE scheduled SET chat_id = ? WHERE chat_id = ?').run(toId, fromId)
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
	// text — строка для полнотекстового поиска (null — не индексировать)
	putMessage(chatId, msg, ts, text) {
		this.s.msgUpsert.run(chatId, msg.key.id, msg.key.fromMe ? 1 : 0, ts, enc(msg))
		if (text === undefined) return
		const rowid = this.s.msgRowid.get(chatId, msg.key.id)?.rowid
		if (rowid == null) return
		this.s.ftsDel.run(rowid)
		if (text) this.s.ftsIns.run(rowid, yo(text), chatId, msg.key.id, ts)
	}
	deleteMessage(chatId, id) {
		const rowid = this.s.msgRowid.get(chatId, id)?.rowid
		if (rowid != null) this.s.ftsDel.run(rowid)
		this.s.msgDel.run(chatId, id)
	}
	pageMessages(chatId, before, limit) {
		return this.s.msgPage.all(chatId, before, limit).map((r) => dec(r.data)).reverse()
	}
	pageAfter(chatId, after, limit) {
		return this.s.msgAfter.all(chatId, after, limit).map((r) => dec(r.data))
	}
	messagesSince(chatId, ts) {
		return this.s.msgSince.all(chatId, ts).map((r) => dec(r.data))
	}
	deleteOlder(chatId, ts) {
		this.s.msgDelOlder.run(chatId, ts)
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
	clearSearchIndex() {
		this.db.exec('DELETE FROM msg_fts')
	}
	*allMessages() {
		for (const r of this.db.prepare('SELECT chat_id, data FROM messages').iterate()) yield [r.chat_id, dec(r.data)]
	}
	search(query, limit = 60) {
		// каждое слово — префиксный поиск, все слова обязательны
		const terms = yo(String(query).toLowerCase()).match(/[\p{L}\p{N}]+/gu)
		if (!terms?.length) return []
		// простая «основа» слова: «дача» → «дач*» найдёт «дачи», «дачу», «даче»
		const stem = (t) => (t.length >= 4 && /[аеёиоуыэюяйь]$/.test(t) ? t.slice(0, -1) : t)
		const q = terms.map((t) => `"${stem(t)}"*`).join(' ')
		return this.s.ftsSearch.all(q, limit)
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
	allContacts() {
		return this.s.contactAll.all()
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

	// ---- scheduled ----
	addScheduled(chatId, text, at) {
		return this.s.schedAdd.run(chatId, text, at, Date.now()).lastInsertRowid
	}
	listScheduled() {
		return this.s.schedList.all()
	}
	dueScheduled(now) {
		return this.s.schedDue.all(now)
	}
	getScheduled(id) {
		return this.s.schedGet.get(id)
	}
	setScheduled(id, status, error = null) {
		this.s.schedSet.run(status, error, id)
	}
	deleteScheduled(id) {
		this.s.schedDel.run(id)
	}

	// ---- auto-reply rules ----
	rules() {
		return this.s.ruleAll.all().map((r) => ({ ...JSON.parse(r.data), id: r.id }))
	}
	saveRule(rule) {
		const { id, ...data } = rule
		if (id) {
			this.s.ruleUpd.run(JSON.stringify(data), id)
			return id
		}
		return Number(this.s.ruleIns.run(Date.now(), JSON.stringify(data)).lastInsertRowid)
	}
	deleteRule(id) {
		this.s.ruleDel.run(id)
	}

	// ---- calls ----
	saveCall(call) {
		this.s.callSet.run(call.id, JSON.stringify(call), call.ts)
	}
	calls() {
		return this.s.callList.all().map((r) => JSON.parse(r.data))
	}

	clearAll() {
		this.db.exec(`DELETE FROM chats; DELETE FROM messages; DELETE FROM reactions; DELETE FROM contacts; DELETE FROM groups;
			DELETE FROM lidmap; DELETE FROM msg_fts; DELETE FROM scheduled; DELETE FROM calls; DELETE FROM kv WHERE k LIKE 'fts%';`)
		this.lidToPn.clear()
	}
	close() {
		try {
			this.db.close()
		} catch {}
	}
}
