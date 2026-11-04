/* global io */
'use strict'

// ============================================================ helpers
const $ = (s, el = document) => el.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const show = (el, v = true) => el.classList.toggle('hidden', !v)
const enc = encodeURIComponent

function toast(text, ms = 3000) {
	const t = $('#toast')
	t.textContent = text
	show(t)
	clearTimeout(toast.t)
	toast.t = setTimeout(() => show(t, false), ms)
}

const COLORS = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774', '#d4a017', '#35a6a6', '#c96bd8']
const colorFor = (s) => {
	let h = 0
	for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0
	return COLORS[Math.abs(h) % COLORS.length]
}
const initials = (name) => {
	const parts = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/)
	return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase()
}
function avatarHTML(id, name, cls = '') {
	return `<div class="avatar ${cls}" style="background:${colorFor(id)}">${esc(initials(name))}<img loading="lazy" src="/avatar/${enc(id)}" alt="" onerror="this.remove()"></div>`
}

const pad = (n) => String(n).padStart(2, '0')
const sameDay = (a, b) => a.toDateString() === b.toDateString()
function fmtListTime(ts) {
	if (!ts) return ''
	const d = new Date(ts * 1000)
	const now = new Date()
	if (sameDay(d, now)) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
	const y = new Date(now)
	y.setDate(now.getDate() - 1)
	if (sameDay(d, y)) return 'Вчера'
	if (now - d < 6 * 864e5) return d.toLocaleDateString('ru-RU', { weekday: 'short' })
	return d.toLocaleDateString('ru-RU')
}
const fmtTime = (ts) => {
	const d = new Date(ts * 1000)
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fmtDay(ts) {
	const d = new Date(ts * 1000)
	const now = new Date()
	if (sameDay(d, now)) return 'Сегодня'
	const y = new Date(now)
	y.setDate(now.getDate() - 1)
	if (sameDay(d, y)) return 'Вчера'
	return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}` : '')
const fmtSize = (b) => (!b ? '' : b < 1024 ? b + ' Б' : b < 1048576 ? (b / 1024).toFixed(0) + ' КБ' : (b / 1048576).toFixed(1) + ' МБ')

// форматирование WhatsApp: *жирный* _курсив_ ~зачёркнутый~ ```моно``` + ссылки
function formatText(t) {
	let s = esc(t)
	s = s.replace(/```([\s\S]+?)```/g, '<code>$1</code>')
	s = s.replace(/(^|[\s(])\*(\S(?:[^*\n]*\S)?)\*(?=$|[\s).,!?:;])/g, '$1<b>$2</b>')
	s = s.replace(/(^|[\s(])_(\S(?:[^_\n]*\S)?)_(?=$|[\s).,!?:;])/g, '$1<i>$2</i>')
	s = s.replace(/(^|[\s(])~(\S(?:[^~\n]*\S)?)~(?=$|[\s).,!?:;])/g, '$1<s>$2</s>')
	s = s.replace(/(https?:\/\/[^\s<]+[^\s<.,:;"')\]])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
	return s
}

const TICK = {
	one: '<svg class="tick" viewBox="0 0 16 11"><path d="M11.1.6 4.6 7.9 1.9 5.3.6 6.6l4 3.9L12.4 1.9z"/></svg>',
	two: '<svg class="tick" viewBox="0 0 16 11"><path d="M11.1.6 4.6 7.9 1.9 5.3.6 6.6l4 3.9L12.4 1.9zM15.1.6 8.6 7.9l-.9-.9-1.3 1.4 2.2 2.1L16.4 1.9z"/></svg>',
	clock: '<svg class="tick" viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 1.3a5.2 5.2 0 1 1 0 10.4A5.2 5.2 0 0 1 8 2.8zM7.4 4.5v4l3 1.8.6-1-2.4-1.4V4.5z"/></svg>'
}
function ticks(status) {
	if (status == null || status <= 1) return TICK.clock
	if (status === 2) return TICK.one
	if (status === 3) return TICK.two
	return TICK.two.replace('class="tick"', 'class="tick read"')
}

// ============================================================ state
const S = {
	state: {},
	chats: new Map(),
	filter: 'all',
	query: '',
	current: null, // id открытого чата
	messages: [], // сообщения открытого чата
	msgIds: new Set(),
	loadingOlder: false,
	noMoreLocal: false,
	waitingHistory: false,
	replyTo: null,
	presence: {},
	group: null,
	loginMode: 'qr'
}

let socket
const isTouch = matchMedia('(hover: none)').matches

// ============================================================ boot / gate
async function boot() {
	const r = await fetch('/api/auth').then((r) => r.json())
	if (r.required && !r.ok) {
		show($('#gate'))
		$('#gate-pass').focus()
		return
	}
	connect()
}
$('#gate-form').addEventListener('submit', async (e) => {
	e.preventDefault()
	const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#gate-pass').value }) })
	if (!r.ok) return ($('#gate-err').textContent = 'Неверный пароль')
	show($('#gate'), false)
	connect()
})

const call = (ev, data) => new Promise((res) => socket.emit(ev, data, (r) => res(r || {})))

function connect() {
	socket = io({ transports: ['websocket', 'polling'] })
	socket.on('connect_error', (e) => {
		if (e.message === 'unauthorized') location.reload()
	})
	socket.on('connect', () => {
		reportClient()
		if (S.state.connection === 'open') loadChats()
	})
	socket.on('state', onState)
	socket.on('chats.update', (list) => {
		for (const c of list) S.chats.set(c.id, c)
		renderChats()
		if (S.current && list.some((c) => c.id === S.current)) renderChatHead()
	})
	socket.on('chat.removed', (id) => {
		S.chats.delete(id)
		renderChats()
	})
	socket.on('message.new', (m) => {
		if (m.chatId !== S.current) return
		addMessages([m], 'append')
	})
	socket.on('message.update', (m) => {
		if (m.chatId !== S.current) return
		const i = S.messages.findIndex((x) => x.id === m.id)
		if (i === -1) return addMessages([m], 'append')
		S.messages[i] = m
		const el = document.querySelector(`[data-mid="${CSS.escape(m.id)}"]`)
		if (el) el.outerHTML = messageHTML(m, S.messages[i - 1])
	})
	socket.on('message.delete', ({ chatId, id }) => {
		if (chatId !== S.current) return
		S.messages = S.messages.filter((m) => m.id !== id)
		document.querySelector(`[data-mid="${CSS.escape(id)}"]`)?.remove()
	})
	socket.on('chat.history', (chatId) => {
		if (chatId === S.current && S.waitingHistory) {
			S.waitingHistory = false
			S.noMoreLocal = false
			loadOlder(true)
		}
	})
	socket.on('presence', ({ chatId, presences }) => {
		S.presence[chatId] = { ...(S.presence[chatId] || {}), ...presences }
		if (chatId === S.current) renderChatHead()
	})
	socket.on('reset', () => {
		S.chats.clear()
		S.chatsLoaded = false
		closeChat()
	})
}

function onState(st) {
	const prev = S.state.connection
	S.state = st
	const loggedIn = st.connection === 'open' || (st.me && st.connection === 'connecting')
	show($('#login'), !loggedIn)
	show($('#app'), !!loggedIn)
	if (!loggedIn) renderLogin()
	else {
		if ((st.connection === 'open' && prev !== 'open') || !S.chatsLoaded) loadChats()
		renderPrivacy()
		show($('#conn-bar'), st.connection !== 'open')
		$('#conn-bar').textContent = 'Подключение к WhatsApp…'
		show($('#sync-bar'), st.sync != null)
		$('#sync-bar').textContent = `Синхронизация истории сообщений… ${st.sync ?? 0}%`
		$('#me-avatar').outerHTML = st.me ? avatarHTML(st.me.id, st.me.name, 'sm').replace('class="avatar sm"', 'class="avatar sm" id="me-avatar" title="' + esc(st.me.name || '') + '"') : '<div id="me-avatar" class="avatar sm"></div>'
		if ($('#drawer').dataset.kind === 'settings') openSettings()
	}
}

// ============================================================ login
function renderLogin() {
	const st = S.state
	const qrMode = S.loginMode === 'qr'
	show($('#login-steps-qr'), qrMode)
	show($('#login-steps-code'), !qrMode)
	show($('#login-qr'), qrMode)
	show($('#login-code'), !qrMode)
	document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === S.loginMode))
	if (st.qr) $('#qr-box').innerHTML = `<img src="${st.qr}" alt="QR-код">`
	else $('#qr-box').innerHTML = st.connection === 'close' ? '<span class="muted">QR-код не активен</span>' : '<div class="spinner"></div>'
	show($('#qr-retry'), st.connection === 'close')
	show($('#pair-code'), !!st.pairingCode)
	$('#pair-code').textContent = st.pairingCode || ''
	$('#login-status').textContent = st.error || (st.connection === 'connecting' ? 'Подключение…' : '')
	if (document.activeElement !== $('#device-name')) $('#device-name').value = st.settings?.deviceName || ''
	if (qrMode && st.connection === 'close' && !st.error && !renderLogin.autostarted) {
		renderLogin.autostarted = true
		call('login.qr')
	}
}
document.querySelectorAll('.tab').forEach((t) =>
	t.addEventListener('click', () => {
		S.loginMode = t.dataset.mode
		renderLogin()
	})
)
$('#qr-retry').addEventListener('click', () => call('login.qr'))
$('#device-save').addEventListener('click', async () => {
	const r = await call('settings.set', { deviceName: $('#device-name').value })
	toast(r.error || 'Сохранено. Отсканируйте новый QR или запросите код заново')
})
$('#login-code').addEventListener('submit', async (e) => {
	e.preventDefault()
	$('#login-status').textContent = 'Запрашиваем код…'
	const r = await call('login.code', { phone: $('#phone').value })
	$('#login-status').textContent = r.error || 'Введите этот код в WhatsApp на телефоне'
})

// ============================================================ privacy
function renderPrivacy() {
	const s = S.state.settings || {}
	$('#privacy-flags').innerHTML =
		`<span class="flag ${s.online ? '' : 'off'}" data-open-settings>${s.online ? '🟢 В сети' : '👻 Невидимка'}</span>` +
		`<span class="flag ${s.readReceipts ? '' : 'off'}" data-open-settings>${s.readReceipts ? '✔✔ Прочтение' : '🙈 Без прочтения'}</span>`
	$('#empty-privacy').textContent =
		(s.online ? 'Ваш статус «В сети» виден, пока открыта вкладка.' : 'Статус «В сети» скрыт.') + ' ' +
		(s.readReceipts ? 'Отчёты о прочтении отправляются.' : 'Отчёты о прочтении не отправляются.')
	renderChatHead()
}
$('#privacy-flags').addEventListener('click', openSettings)

// ============================================================ chats
async function loadChats() {
	S.chatsLoaded = true
	const r = await call('chats.list')
	if (!r.chats) return (S.chatsLoaded = false)
	S.chats = new Map(r.chats.map((c) => [c.id, c]))
	renderChats()
}

function visibleChats() {
	const q = S.query.trim().toLowerCase()
	return [...S.chats.values()]
		.filter((c) => {
			if (q) return (c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(q)
			if (S.filter === 'archived') return c.archived
			if (c.archived) return false
			if (S.filter === 'unread') return c.unread > 0
			if (S.filter === 'groups') return c.isGroup
			return true
		})
		.filter((c) => c.last || c.isGroup || c.id === S.current)
		.sort((a, b) => (b.pinned - a.pinned) || (b.ts - a.ts))
}

function chatItemHTML(c) {
	const last = c.last
	let preview = ''
	if (last) {
		if (last.fromMe) preview += `<span class="meta-icons">${ticks(last.status)}</span>`
		else if (last.sender) preview += esc(last.sender) + ': '
		preview += esc(last.text)
	}
	return `<div class="chat-item ${c.id === S.current ? 'active' : ''} ${c.unread ? 'unread' : ''}" data-chat="${esc(c.id)}">
		${avatarHTML(c.id, c.name)}
		<div class="body">
			<div class="row"><div class="name">${esc(c.name)}</div><div class="time">${fmtListTime(c.ts)}</div></div>
			<div class="row"><div class="preview">${preview}</div>
				<div class="meta-icons">${c.muted ? '🔕' : ''}${c.pinned ? '📌' : ''}${c.unread ? `<span class="badge">${c.unread > 0 ? c.unread : ''}</span>` : ''}</div>
			</div>
		</div></div>`
}

let renderChatsQueued = false
function renderChats() {
	if (renderChatsQueued) return
	renderChatsQueued = true
	requestAnimationFrame(() => {
		renderChatsQueued = false
		const list = visibleChats()
		const el = $('#chat-list')
		const top = el.scrollTop
		// рисуем не больше 400 чатов за раз, остальные — при прокрутке
		const limit = Math.max(400, renderChats.limit || 0)
		el.innerHTML = list.length ? list.slice(0, limit).map(chatItemHTML).join('') : `<div class="list-empty">${S.state.sync != null ? 'Загрузка чатов…' : 'Чатов нет'}</div>`
		el.scrollTop = top
		const unread = [...S.chats.values()].filter((c) => c.unread > 0 && !c.archived && !c.muted).length
		document.title = unread ? `(${unread}) WA Web` : 'WA Web'
	})
}
$('#chat-list').addEventListener('scroll', (e) => {
	const el = e.target
	if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) {
		const total = visibleChats().length
		if ((renderChats.limit || 400) < total) {
			renderChats.limit = (renderChats.limit || 400) + 400
			renderChats()
		}
	}
})
$('#chat-list').addEventListener('click', (e) => {
	if (Date.now() - lastLongPress < 700) return
	const item = e.target.closest('[data-chat]')
	if (item) openChat(item.dataset.chat)
})
$('#chat-list').addEventListener('contextmenu', (e) => {
	const item = e.target.closest('[data-chat]')
	if (!item) return
	e.preventDefault()
	if (Date.now() - lastLongPress < 1000) return
	chatMenu(item.dataset.chat, e.clientX, e.clientY)
})
function chatMenu(id, x, y) {
	const c = S.chats.get(id)
	menu(x, y, [
		['Открыть', () => openChat(id)],
		c?.unread ? ['Отметить прочитанным', () => markRead(id)] : ['Отметить непрочитанным', () => call('chat.unread', { chatId: id })]
	])
}
$('#search').addEventListener('input', (e) => {
	S.query = e.target.value
	renderChats()
})
document.querySelectorAll('.chip').forEach((b) =>
	b.addEventListener('click', () => {
		S.filter = b.dataset.filter
		document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('active', x === b))
		renderChats()
	})
)
$('#btn-new').addEventListener('click', () => {
	modal(`<h3>Новый чат</h3><input class="field" id="new-phone" type="tel" placeholder="Номер, например +7 777 123 45 67">
		<div class="actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="new-go">Открыть</button></div>`)
	$('#new-phone').focus()
	const go = () => {
		const d = $('#new-phone').value.replace(/\D/g, '')
		if (d.length < 8) return toast('Введите номер полностью')
		const id = d + '@s.whatsapp.net'
		if (!S.chats.has(id)) S.chats.set(id, { id, name: '+' + d, phone: '+' + d, unread: 0, ts: Math.floor(Date.now() / 1000) })
		closeModal()
		openChat(id)
	}
	$('#new-go').onclick = go
	$('#new-phone').onkeydown = (e) => e.key === 'Enter' && go()
})

// ============================================================ open chat
async function openChat(id) {
	if (S.current === id) return
	S.current = id
	S.messages = []
	S.msgIds = new Set()
	S.noMoreLocal = false
	S.waitingHistory = false
	S.group = null
	setReply(null)
	$('#msg-list').innerHTML = ''
	$('#older-status').textContent = ''
	show($('#empty'), false)
	show($('#chat'))
	$('#app').classList.add('chat-open')
	navPush('chat')
	if ($('#drawer').dataset.kind === 'info') closeDrawer()
	renderChats()
	renderChatHead()
	reportClient()
	const r = await call('messages.list', { chatId: id, limit: 50 })
	if (S.current !== id) return
	addMessages(r.messages || [], 'replace')
	S.noMoreLocal = !r.hasMore
	if (r.requested && !r.hasMore) {
		S.waitingHistory = true
		$('#older-status').textContent = 'Загрузка истории с телефона…'
	}
	if (!isTouch) $('#input').focus() // на телефоне не открываем клавиатуру сразу
	if (S.chats.get(id)?.isGroup) call('group.info', { chatId: id }).then((g) => {
		if (S.current === id && g.group) {
			S.group = g.group
			renderChatHead()
		}
	})
}
// ---- кнопка «Назад» телефона закрывает верхний экран, а не сайт
const nav = []
const navClosers = { chat: () => _closeChat(), drawer: () => _closeDrawer(), lightbox: () => _closeLightbox() }
function navPush(kind) {
	if (nav.includes(kind)) return
	nav.push(kind)
	history.pushState({ nav: nav.length }, '')
}
function navClose(kind) {
	if (nav[nav.length - 1] === kind) return history.back() // popstate закроет
	const i = nav.indexOf(kind)
	if (i !== -1) nav.splice(i, 1)
	navClosers[kind]()
}
window.addEventListener('popstate', () => {
	const kind = nav.pop()
	if (kind) navClosers[kind]()
})
const closeChat = () => navClose('chat')
function _closeChat() {
	S.current = null
	show($('#chat'), false)
	show($('#empty'))
	$('#app').classList.remove('chat-open')
	reportClient()
	renderChats()
}
$('#btn-back').addEventListener('click', closeChat)

function renderChatHead() {
	if (!S.current) return
	const c = S.chats.get(S.current) || { id: S.current, name: S.current.split('@')[0] }
	$('#chat-avatar').outerHTML = avatarHTML(c.id, c.name).replace('class="avatar "', 'class="avatar" id="chat-avatar"')
	$('#chat-name').textContent = c.name
	let sub = ''
	const pres = S.presence[c.id] || {}
	if (c.isGroup) {
		const typing = Object.values(pres).filter((p) => p.state === 'composing' || p.state === 'recording')
		if (typing.length) sub = typing.map((p) => p.name).join(', ') + (typing[0].state === 'recording' ? ' записывает аудио…' : ' печатает…')
		else if (S.group) sub = S.group.participants.map((p) => p.name).join(', ')
		else sub = 'нажмите для информации о группе'
	} else {
		const p = pres[c.id]
		if (p?.state === 'composing') sub = 'печатает…'
		else if (p?.state === 'recording') sub = 'записывает аудио…'
		else if (p?.state === 'available') sub = 'в сети'
		else if (p?.lastSeen) sub = 'был(а) ' + fmtDay(p.lastSeen).toLowerCase() + ' в ' + fmtTime(p.lastSeen)
		else sub = c.phone || ''
	}
	$('#chat-sub').textContent = sub
	const readOff = !S.state.settings?.readReceipts
	show($('#btn-mark-read'), readOff && c.unread > 0)
	$('#btn-mark-read').textContent = `Прочитать (${c.unread > 0 ? c.unread : ''})`.replace(' ()', '')
}
$('#chat-title-wrap').addEventListener('click', openInfo)
$('#btn-mark-read').addEventListener('click', () => markRead(S.current))
$('#btn-chat-menu').addEventListener('click', (e) => {
	const r = e.currentTarget.getBoundingClientRect()
	const id = S.current
	const c = S.chats.get(id)
	menu(r.left - 150, r.bottom, [
		['Информация', openInfo],
		c?.unread ? ['Отметить прочитанным', () => markRead(id)] : ['Отметить непрочитанным', () => call('chat.unread', { chatId: id })],
		['Закрыть чат', closeChat]
	])
})
async function markRead(id) {
	const r = await call('chat.read', { chatId: id })
	if (r.error) toast(r.error)
	else toast('Отчёт о прочтении отправлен')
}

// ============================================================ messages render
function messageHTML(m, prev) {
	let html = ''
	if (!prev || !sameDay(new Date(prev.ts * 1000), new Date(m.ts * 1000))) html += `<div class="day-sep">${fmtDay(m.ts)}</div>`
	if (m.type === 'system') return html + `<div class="sys" data-mid="${esc(m.id)}">${m.senderName && !m.fromMe ? esc(m.senderName) + ' ' : ''}${esc(m.text)}</div>`
	const first = !prev || prev.fromMe !== m.fromMe || prev.sender !== m.sender || prev.type === 'system' || !sameDay(new Date(prev.ts * 1000), new Date(m.ts * 1000))
	const isGroup = m.chatId.endsWith('@g.us')
	const metaHTML = `<span class="meta">${m.edited ? 'изм. ' : ''}${fmtTime(m.ts)}${m.fromMe ? ticks(m.status) : ''}</span>`
	let body = ''
	let cls = ''
	const src = `/media/${enc(m.chatId)}/${enc(m.id)}`
	const thumb = m.media?.thumb ? `data:image/jpeg;base64,${m.media.thumb}` : ''

	if (m.deleted) body = `<div class="text deleted">🚫 ${m.fromMe ? 'Вы удалили это сообщение' : 'Сообщение удалено'}</div>`
	else {
		if (m.forwarded) body += '<div class="fwd">↪ Пересланное сообщение</div>'
		if (m.quoted) {
			body += `<div class="quote" data-jump="${esc(m.quoted.id)}">${m.quoted.thumb ? '' : ''}<div class="q-body"><div class="q-name">${esc(m.quoted.senderName || (m.quoted.sender ? '' : ''))}</div><div class="q-text">${esc(m.quoted.text)}</div></div>${m.quoted.thumb ? `<img src="data:image/jpeg;base64,${m.quoted.thumb}" alt="">` : ''}</div>`
		}
		switch (m.type) {
			case 'image':
				body += `<div class="media-wrap" data-view="image" data-src="${src}"><img src="${src}" loading="lazy" style="${thumb ? `background:url(${thumb}) center/cover` : ''};aspect-ratio:${m.media.width && m.media.height ? m.media.width + '/' + m.media.height : 'auto'}" alt="" ${thumb ? `onerror="this.onerror=null;this.src='${thumb}'"` : ''}></div>`
				break
			case 'video':
				if (m.media.round) cls += ' round'
				body += `<div class="media-wrap ${m.media.round ? 'round' : ''}" data-view="video" data-src="${src}">${thumb ? `<img src="${thumb}" alt="" style="aspect-ratio:${m.media.width && m.media.height ? m.media.width + '/' + m.media.height : '16/9'}">` : '<div class="ph"></div>'}<div class="play"><span>▶</span></div><span class="dur">${m.media.gif ? 'GIF' : fmtDur(m.media.seconds)}</span></div>`
				break
			case 'audio':
				body += `<div class="voice">${m.media.ptt ? '<span class="mic">🎤</span>' : '<span class="mic">🎵</span>'}<audio controls preload="none" src="${src}" data-played="${esc(m.id)}"></audio></div>`
				break
			case 'sticker':
				cls += ' sticker-b'
				body += `<img class="sticker" src="${src}" loading="lazy" alt="Стикер">`
				break
			case 'document': {
				const ext = (m.media.fileName || '').split('.').pop().slice(0, 4) || 'file'
				body += `<a class="doc" href="${src}?download=1" target="_blank"><span class="ext">${esc(ext)}</span><span class="info"><div class="fname">${esc(m.media.fileName || 'Документ')}</div><div class="fsize">${[fmtSize(m.media.size), m.media.pages ? m.media.pages + ' стр.' : ''].filter(Boolean).join(' · ')}</div></span><span>⬇</span></a>`
				break
			}
			case 'location': {
				const l = m.location
				const url = `https://maps.google.com/?q=${l.lat},${l.lng}`
				body += `<div class="loc"><a href="${url}" target="_blank" rel="noopener">${l.thumb ? `<img src="data:image/jpeg;base64,${l.thumb}" alt="">` : ''}<div>📍 ${esc(l.name || (l.live ? 'Геолокация в реальном времени' : 'Геолокация'))}</div>${l.address ? `<div class="muted">${esc(l.address)}</div>` : ''}</a></div>`
				break
			}
			case 'contact':
				body += `<div class="contact-card">${avatarHTML('c' + m.id, m.contact.name, 'sm')}<div><b>${esc(m.contact.name)}</b><div class="muted">${esc((m.contact.vcard || '').match(/waid=\d+:([^\n]+)/)?.[1] || (m.contact.vcard || '').match(/TEL[^:]*:([^\n]+)/)?.[1] || '')}</div></div></div>`
				break
			case 'poll':
				body += `<div class="poll"><b>📊 ${esc(m.poll.name)}</b>${m.poll.options.map((o) => `<div class="opt">${esc(o)}</div>`).join('')}<div class="muted">${m.poll.multi ? 'Можно выбрать несколько' : 'Выберите один вариант'}</div></div>`
				break
		}
		if (m.link && m.type === 'text') {
			body += `<a class="link-prev" href="${esc(m.link.url)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${m.link.thumb ? `<img src="data:image/jpeg;base64,${m.link.thumb}" alt="">` : ''}<div><b>${esc(m.link.title || '')}</b><span class="muted">${esc(m.link.description || '')}</span></div></a>`
		}
		if (m.text) body += `<div class="text">${formatText(m.text)}${m.viewOnce ? ' <span class="muted">(однократный просмотр)</span>' : ''}</div>`
	}
	const mediaOnly = !m.deleted && !m.text && !m.quoted && !m.forwarded && ['image', 'video'].includes(m.type)
	if (mediaOnly) cls += ' media-only'
	const sender = isGroup && !m.fromMe && first && m.type !== 'sticker' ? `<div class="sender" style="color:${colorFor(m.sender)}">${esc(m.senderName)}</div>` : ''
	const reacts = m.reactions?.length
		? `<div class="reactions"><span class="react-pill" title="${esc(m.reactions.map((r) => r.name + ' ' + r.text).join('\n'))}">${[...new Set(m.reactions.map((r) => r.text))].join('')}${m.reactions.length > 1 ? ' ' + m.reactions.length : ''}</span></div>`
		: ''
	return (
		html +
		`<div class="msg ${m.fromMe ? 'out' : 'in'} ${first ? 'first' : ''}" data-mid="${esc(m.id)}"><div class="msg-col">
			<div class="bubble${cls}">${sender}${body}${metaHTML}<button class="more" data-more="${esc(m.id)}">⌄</button></div>${reacts}
		</div></div>`
	)
}

function nearBottom() {
	const el = $('#messages')
	return el.scrollHeight - el.scrollTop - el.clientHeight < 150
}
function scrollBottom() {
	const el = $('#messages')
	el.scrollTop = el.scrollHeight
	S.atBottom = true
}
// картинки догружаются и меняют высоту — держим ленту внизу
$('#msg-list').addEventListener('load', () => S.atBottom && scrollBottom(), true)

function addMessages(list, mode) {
	const fresh = list.filter((m) => m && !S.msgIds.has(m.id))
	fresh.forEach((m) => S.msgIds.add(m.id))
	const el = $('#messages')
	if (mode === 'replace') {
		S.messages = fresh.sort((a, b) => a.ts - b.ts)
		$('#msg-list').innerHTML = S.messages.map((m, i) => messageHTML(m, S.messages[i - 1])).join('')
		scrollBottom()
		// догружаем, если экран не заполнен
		setTimeout(() => el.scrollHeight <= el.clientHeight + 50 && loadOlder(), 50)
		return
	}
	if (!fresh.length) return
	if (mode === 'prepend') {
		const h = el.scrollHeight
		const top = el.scrollTop
		S.messages = [...fresh.sort((a, b) => a.ts - b.ts), ...S.messages]
		$('#msg-list').innerHTML = S.messages.map((m, i) => messageHTML(m, S.messages[i - 1])).join('')
		el.scrollTop = top + (el.scrollHeight - h)
		return
	}
	// append
	const stick = nearBottom() || fresh.some((m) => m.fromMe)
	for (const m of fresh.sort((a, b) => a.ts - b.ts)) {
		const prev = S.messages[S.messages.length - 1]
		S.messages.push(m)
		$('#msg-list').insertAdjacentHTML('beforeend', messageHTML(m, prev))
	}
	if (stick) scrollBottom()
	else show($('#btn-down'))
}

async function loadOlder(force) {
	if (!S.current || S.loadingOlder || (S.noMoreLocal && !force)) return
	if (S.noMoreLocal && S.waitingHistory) return
	const id = S.current
	S.loadingOlder = true
	const before = S.messages[0]?.ts
	const r = await call('messages.list', { chatId: id, before, limit: 50 })
	S.loadingOlder = false
	if (S.current !== id) return
	const fresh = (r.messages || []).filter((m) => !S.msgIds.has(m.id))
	addMessages(fresh, 'prepend')
	if (!fresh.length || !r.hasMore) {
		S.noMoreLocal = true
		if (r.requested) {
			S.waitingHistory = true
			$('#older-status').textContent = 'Загрузка истории с телефона…'
			clearTimeout(loadOlder.t)
			loadOlder.t = setTimeout(() => {
				if (S.current === id && S.waitingHistory) {
					S.waitingHistory = false
					$('#older-status').textContent = 'Более ранних сообщений нет'
				}
			}, 25000)
		} else $('#older-status').textContent = S.messages.length ? 'Начало переписки' : 'Сообщений пока нет'
	} else $('#older-status').textContent = ''
}

$('#messages').addEventListener('scroll', () => {
	const el = $('#messages')
	S.atBottom = nearBottom()
	if (el.scrollTop < 300) loadOlder()
	if (nearBottom()) show($('#btn-down'), false)
})
$('#btn-down').addEventListener('click', () => {
	scrollBottom()
	show($('#btn-down'), false)
})

// клики по сообщениям
$('#msg-list').addEventListener('click', (e) => {
	const view = e.target.closest('[data-view]')
	if (view) return openLightbox(view.dataset.view, view.dataset.src)
	const jump = e.target.closest('[data-jump]')
	if (jump) {
		const el = document.querySelector(`[data-mid="${CSS.escape(jump.dataset.jump)}"]`)
		if (el) {
			el.scrollIntoView({ block: 'center', behavior: 'smooth' })
			el.classList.add('flash')
			setTimeout(() => el.classList.remove('flash'), 1300)
		} else toast('Сообщение не загружено — прокрутите выше')
		return
	}
	const more = e.target.closest('[data-more]')
	if (more) return messageMenu(more.dataset.more, e.clientX, e.clientY)
})
// Долгое нажатие → меню (Safari на iPhone не присылает contextmenu), свайп вправо → ответить
let lastLongPress = 0
function touchGestures(container, selector, onLong, onSwipe) {
	let t = null
	let start = null
	let el = null
	let swiping = false
	container.addEventListener('touchstart', (e) => {
		el = e.target.closest(selector)
		if (!el || e.touches.length > 1) return
		const p = e.touches[0]
		start = { x: p.clientX, y: p.clientY }
		swiping = false
		t = setTimeout(() => {
			t = null
			lastLongPress = Date.now()
			navigator.vibrate?.(15)
			onLong(el, start.x, start.y)
		}, 450)
	}, { passive: true })
	container.addEventListener('touchmove', (e) => {
		if (!start || !el) return
		const p = e.touches[0]
		const dx = p.clientX - start.x
		const dy = p.clientY - start.y
		if (t && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
			clearTimeout(t)
			t = null
		}
		if (!onSwipe) return
		if (!swiping && dx > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) swiping = true
		if (swiping) {
			const shift = Math.max(0, Math.min(dx, 90))
			el.style.transform = `translateX(${shift}px)`
			el.classList.toggle('swipe-ready', shift > 60)
		}
	}, { passive: true })
	const end = (e) => {
		clearTimeout(t)
		t = null
		// после долгого нажатия браузер шлёт клик — он не должен нажать пункт открывшегося меню
		if (e?.cancelable && Date.now() - lastLongPress < 1500 && start) e.preventDefault()
		if (swiping && el) {
			const ready = el.classList.contains('swipe-ready')
			el.style.transform = ''
			el.classList.remove('swipe-ready')
			if (ready) onSwipe(el)
		}
		swiping = false
		start = null
		el = null
	}
	container.addEventListener('touchend', end, { passive: false })
	container.addEventListener('touchcancel', end)
}
touchGestures(
	$('#msg-list'),
	'.msg[data-mid]',
	(el, x, y) => messageMenu(el.dataset.mid, x, y),
	(el) => setReply(S.messages.find((m) => m.id === el.dataset.mid))
)
touchGestures($('#chat-list'), '[data-chat]', (el, x, y) => chatMenu(el.dataset.chat, x, y))

$('#msg-list').addEventListener('contextmenu', (e) => {
	if (Date.now() - lastLongPress < 1000) return e.preventDefault()
	const el = e.target.closest('[data-mid]')
	if (!el || el.classList.contains('sys')) return
	e.preventDefault()
	messageMenu(el.dataset.mid, e.clientX, e.clientY)
})
$('#msg-list').addEventListener('dblclick', (e) => {
	const el = e.target.closest('.msg[data-mid]')
	if (el && !e.target.closest('a,audio,video')) setReply(S.messages.find((m) => m.id === el.dataset.mid))
})
// голосовое прослушано → отчёт «прослушано» (только если включены отчёты о прочтении)
$('#msg-list').addEventListener(
	'play',
	(e) => {
		const id = e.target.dataset?.played
		if (id && S.state.settings?.readReceipts) call('message.played', { chatId: S.current, msgId: id })
	},
	true
)

const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏']
function messageMenu(id, x, y) {
	const m = S.messages.find((x) => x.id === id)
	if (!m) return
	const items = [['Ответить', () => setReply(m)]]
	if (m.text) items.push(['Копировать текст', () => navigator.clipboard?.writeText(m.text).then(() => toast('Скопировано'))])
	if (m.media) items.push(['Скачать', () => window.open(`/media/${enc(m.chatId)}/${enc(m.id)}?download=1`)])
	if (m.reactions?.some((r) => r.fromMe)) items.push(['Убрать реакцию', () => react(m, '')])
	if (m.fromMe && !m.deleted) items.push(['Удалить у всех', () => confirmModal('Удалить сообщение у всех?', () => call('message.delete', { chatId: m.chatId, msgId: m.id }).then((r) => r.error && toast(r.error)))])
	menu(x, y, items, QUICK.map((q) => [q, () => react(m, q)]))
}
const react = (m, emoji) => call('message.react', { chatId: m.chatId, msgId: m.id, emoji }).then((r) => r.error && toast(r.error))

// ============================================================ composer
const input = $('#input')
function autosize() {
	input.style.height = 'auto'
	input.style.height = Math.min(input.scrollHeight, 140) + 'px'
	$('.composer').classList.toggle('has-text', !!input.value.trim())
}
let typingSent = 0
input.addEventListener('input', () => {
	autosize()
	if (S.current && Date.now() - typingSent > 4000) {
		typingSent = Date.now()
		call('typing', { chatId: S.current, composing: true })
	}
})
input.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch) {
		e.preventDefault()
		sendText()
	}
	if (e.key === 'Escape') setReply(null)
})
$('#btn-send').addEventListener('click', () => {
	if (rec) return stopRecording(true)
	if (input.value.trim()) sendText()
	else startRecording()
})

async function sendText() {
	const text = input.value.trim()
	if (!text || !S.current) return
	input.value = ''
	autosize()
	const quotedId = S.replyTo?.id
	setReply(null)
	typingSent = 0
	call('typing', { chatId: S.current, composing: false })
	const r = await call('message.send', { chatId: S.current, text, quotedId })
	if (r.error) {
		toast('Не отправлено: ' + r.error)
		input.value = text
		autosize()
	}
}

function setReply(m) {
	S.replyTo = m || null
	show($('#reply-bar'), !!m)
	if (!m) return
	$('#reply-name').textContent = m.fromMe ? 'Вы' : m.senderName || S.chats.get(m.chatId)?.name || ''
	$('#reply-text').textContent = m.text || { image: '📷 Фото', video: '🎥 Видео', audio: '🎤 Аудио', document: '📄 ' + (m.media?.fileName || 'Документ'), sticker: 'Стикер' }[m.type] || ''
	input.focus()
}
$('#reply-cancel').addEventListener('click', () => setReply(null))

// эмодзи
const EMOJI = '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😋 😛 😜 🤪 😝 🤗 🤭 🤫 🤔 🤐 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖 😺 👋 🤚 ✋ 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 👍 👎 ✊ 👊 👏 🙌 🤝 🙏 💪 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 ❣️ 💕 💯 🔥 ✨ ⭐ 🎉 🎂 🎁 ☕ 🍕 ⚽ 🚗 ✈️ 🏠 📷 📞 💰 ✅ ❌ ⚠️ ❓'.split(' ')
$('#emoji-pop').innerHTML = EMOJI.map((e) => `<button type="button">${e}</button>`).join('')
$('#btn-emoji').addEventListener('click', (e) => {
	e.stopPropagation()
	show($('#emoji-pop'), $('#emoji-pop').classList.contains('hidden'))
})
$('#emoji-pop').addEventListener('click', (e) => {
	e.stopPropagation()
	if (e.target.tagName !== 'BUTTON') return
	const pos = input.selectionStart ?? input.value.length
	input.value = input.value.slice(0, pos) + e.target.textContent + input.value.slice(input.selectionEnd ?? pos)
	input.selectionStart = input.selectionEnd = pos + e.target.textContent.length
	autosize()
	input.focus()
})

// вложения
$('#btn-attach').addEventListener('click', () => $('#file-input').click())
$('#file-input').addEventListener('change', (e) => {
	const files = [...e.target.files]
	e.target.value = ''
	if (files.length) attachModal(files)
})
$('#messages').addEventListener('dragover', (e) => e.preventDefault())
$('#messages').addEventListener('drop', (e) => {
	e.preventDefault()
	const files = [...(e.dataTransfer?.files || [])]
	if (files.length && S.current) attachModal(files)
})
input.addEventListener('paste', (e) => {
	const files = [...(e.clipboardData?.files || [])]
	if (files.length) {
		e.preventDefault()
		attachModal(files)
	}
})
const kindOf = (f) => (f.type.startsWith('image/') && !/svg|gif/.test(f.type) ? 'image' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : 'document')
function attachModal(files) {
	const urls = files.map((f) => URL.createObjectURL(f))
	const prev = files
		.map((f, i) => {
			const k = kindOf(f)
			if (k === 'image') return `<img src="${urls[i]}" alt="">`
			if (k === 'video') return `<video src="${urls[i]}" muted></video>`
			return `<div>📄 ${esc(f.name)} <span class="muted">${fmtSize(f.size)}</span></div>`
		})
		.join('')
	modal(`<h3>Отправить ${files.length > 1 ? files.length + ' файла(ов)' : 'файл'}</h3><div class="preview">${prev}</div>
		<label style="font-size:13px"><input type="checkbox" id="as-doc"> Отправить как документ (без сжатия)</label>
		<input class="field" id="caption" type="text" placeholder="Подпись">
		<div class="actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="send-files">Отправить</button></div>`, () => urls.forEach(URL.revokeObjectURL))
	$('#caption').focus()
	const go = async () => {
		const caption = $('#caption').value
		const asDoc = $('#as-doc').checked
		const chatId = S.current
		const quotedId = S.replyTo?.id
		closeModal()
		setReply(null)
		for (const [i, f] of files.entries()) {
			if (f.size > 95 * 1024 * 1024) {
				toast(`${f.name}: файл слишком большой`)
				continue
			}
			toast(`Отправка ${f.name}…`, 60000)
			const r = await call('message.media', { chatId, kind: asDoc ? 'document' : kindOf(f), data: await f.arrayBuffer(), mimetype: f.type, fileName: f.name, caption: i === 0 ? caption : undefined, quotedId: i === 0 ? quotedId : undefined })
			toast(r.error ? `Ошибка: ${r.error}` : 'Отправлено')
		}
	}
	$('#send-files').onclick = go
	$('#caption').onkeydown = (e) => e.key === 'Enter' && go()
}

// голосовые
let rec = null
async function startRecording() {
	if (!S.current) return
	if (!navigator.mediaDevices?.getUserMedia) return toast('Запись недоступна: откройте страницу по HTTPS или через localhost')
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
		const mime = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || ''
		const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
		const chunks = []
		mr.ondataavailable = (e) => e.data.size && chunks.push(e.data)
		rec = { mr, stream, chunks, start: Date.now(), chatId: S.current, mime: mr.mimeType || mime }
		mr.start(250)
		$('.composer').classList.add('recording')
		show($('#rec-bar'))
		rec.timer = setInterval(() => ($('#rec-time').textContent = fmtDur((Date.now() - rec.start) / 1000) || '0:00'), 500)
		if (S.state.settings?.online) call('typing', { chatId: S.current, composing: true })
	} catch (err) {
		toast('Нет доступа к микрофону')
	}
}
function stopRecording(send) {
	if (!rec) return
	const r = rec
	rec = null
	clearInterval(r.timer)
	$('.composer').classList.remove('recording')
	show($('#rec-bar'), false)
	$('#rec-time').textContent = '0:00'
	r.mr.onstop = async () => {
		r.stream.getTracks().forEach((t) => t.stop())
		if (!send || Date.now() - r.start < 800) return
		const blob = new Blob(r.chunks, { type: r.mime })
		toast('Отправка голосового…', 60000)
		const res = await call('message.media', { chatId: r.chatId, kind: 'voice', data: await blob.arrayBuffer(), mimetype: r.mime })
		toast(res.error ? 'Ошибка: ' + res.error : 'Голосовое отправлено')
	}
	r.mr.stop()
}
$('#rec-cancel').addEventListener('click', () => stopRecording(false))

// ============================================================ drawer: settings / info
function openDrawer(kind, title, html) {
	const d = $('#drawer')
	d.dataset.kind = kind
	$('#drawer-title').textContent = title
	$('#drawer-body').innerHTML = html
	show(d)
	navPush('drawer')
}
const closeDrawer = () => navClose('drawer')
function _closeDrawer() {
	$('#drawer').dataset.kind = ''
	show($('#drawer'), false)
}
$('#drawer-close').addEventListener('click', closeDrawer)
$('#btn-settings').addEventListener('click', openSettings)

function openSettings() {
	const s = S.state.settings || {}
	const me = S.state.me || {}
	openDrawer(
		'settings',
		'Настройки',
		`<div class="profile-head">${avatarHTML(me.id || 'me', me.name, 'xl')}<h2>${esc(me.name || '')}</h2><div class="muted">${me.id ? '+' + esc(me.id.split('@')[0]) : ''}</div></div>
		<div class="section-title">Приватность</div>
		<label class="setting">
			<div class="s-text"><div class="s-title">Показывать «В сети»</div>
			<div class="s-desc">Если выключено, этот клиент никогда не сообщает WhatsApp, что вы онлайн, и не показывает «печатает…». Собеседники не увидят «в сети» из-за этой вкладки. Учтите: открытое приложение на телефоне по-прежнему показывает вас в сети.</div></div>
			<span class="switch"><input type="checkbox" id="set-online" ${s.online ? 'checked' : ''}><span></span></span>
		</label>
		<label class="setting">
			<div class="s-text"><div class="s-title">Отправлять отчёты о прочтении</div>
			<div class="s-desc">Если выключено, открытие чата не ставит собеседнику синие галочки, а голосовые не отмечаются прослушанными. Чат остаётся непрочитанным и на телефоне. Отметить прочитанным можно вручную кнопкой в шапке чата.</div></div>
			<span class="switch"><input type="checkbox" id="set-read" ${s.readReceipts ? 'checked' : ''}><span></span></span>
		</label>
		<div class="section-title">Оформление</div>
		<div class="setting"><div class="s-text"><div class="s-title">Тема</div></div>
			<select id="set-theme" class="field" style="width:auto">
				<option value="">Системная</option><option value="light">Светлая</option><option value="dark">Тёмная</option>
			</select></div>
		<div style="margin-top:24px"><button class="btn danger" id="btn-logout">Выйти из WhatsApp</button></div>`
	)
	$('#set-online').onchange = (e) => saveSettings({ online: e.target.checked })
	$('#set-read').onchange = (e) => saveSettings({ readReceipts: e.target.checked })
	$('#set-theme').value = localGet('theme') || ''
	$('#set-theme').onchange = (e) => {
		localSet('theme', e.target.value)
		applyTheme()
	}
	$('#btn-logout').onclick = () => confirmModal('Выйти из аккаунта? Устройство будет отвязано, локальная история удалена.', async () => {
		await call('logout')
		closeDrawer()
	})
}
async function saveSettings(patch) {
	const r = await call('settings.set', patch)
	if (r.error) toast(r.error)
}

async function openInfo() {
	const id = S.current
	const c = S.chats.get(id) || { id, name: id }
	if (!c.isGroup) {
		openDrawer('info', 'Данные контакта', `<div class="profile-head">${avatarHTML(c.id, c.name, 'xl')}<h2>${esc(c.name)}</h2><div class="muted">${esc(c.phone || id)}</div></div>`)
		return
	}
	openDrawer('info', 'Данные группы', `<div class="profile-head">${avatarHTML(c.id, c.name, 'xl')}<h2>${esc(c.name)}</h2></div><div class="spinner" style="margin:20px auto"></div>`)
	const r = await call('group.info', { chatId: id })
	const g = r.group
	if (!g || S.current !== id || $('#drawer').dataset.kind !== 'info') return
	S.group = g
	$('#drawer-body').innerHTML = `<div class="profile-head">${avatarHTML(c.id, c.name, 'xl')}<h2>${esc(g.subject || c.name)}</h2><div class="muted">Группа · ${g.participants.length} участник(ов)</div></div>
		${g.desc ? `<div class="section-title">Описание</div><div style="white-space:pre-wrap">${formatText(g.desc)}</div>` : ''}
		<div class="section-title">Участники</div>
		${g.participants
			.sort((a, b) => !!b.admin - !!a.admin)
			.map((p) => `<div class="member">${avatarHTML(p.id, p.name, 'sm')}<div style="flex:1;min-width:0">${esc(p.name)}<div class="muted" style="font-size:12px">${p.id.endsWith('@s.whatsapp.net') ? '+' + esc(p.id.split('@')[0]) : ''}</div></div>${p.admin ? '<span class="admin">админ</span>' : ''}</div>`)
			.join('')}`
}

// ============================================================ overlays
function menu(x, y, items, quick) {
	const m = $('#ctx-menu')
	m.innerHTML = (quick ? `<div class="quick">${quick.map(([t], i) => `<button data-q="${i}">${t}</button>`).join('')}</div>` : '') + items.map(([t], i) => `<button data-i="${i}">${esc(t)}</button>`).join('')
	show(m)
	const w = m.offsetWidth
	const h = m.offsetHeight
	m.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px'
	m.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px'
	m.onclick = (e) => {
		const b = e.target.closest('button')
		if (!b || Date.now() - lastLongPress < 500) return
		show(m, false)
		if (b.dataset.q != null) quick[b.dataset.q][1]()
		else items[b.dataset.i][1]()
	}
}
document.addEventListener('click', (e) => {
	if (Date.now() - lastLongPress < 700) return
	if (!e.target.closest('#ctx-menu') && !e.target.closest('[data-more]')) show($('#ctx-menu'), false)
	if (!e.target.closest('#emoji-pop')) show($('#emoji-pop'), false)
})
document.addEventListener('keydown', (e) => {
	if (e.key !== 'Escape') return
	show($('#ctx-menu'), false)
	if (!$('#lightbox').classList.contains('hidden')) closeLightbox()
	else if (!$('#modal').classList.contains('hidden')) closeModal()
})

let modalCleanup = null
function modal(html, cleanup) {
	modalCleanup = cleanup
	$('#modal').innerHTML = `<div class="card">${html}</div>`
	show($('#modal'))
}
function closeModal() {
	show($('#modal'), false)
	$('#modal').innerHTML = ''
	modalCleanup?.()
	modalCleanup = null
}
$('#modal').addEventListener('click', (e) => {
	if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal()
})
function confirmModal(text, ok) {
	modal(`<h3>${esc(text)}</h3><div class="actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="confirm-ok">OK</button></div>`)
	$('#confirm-ok').onclick = () => {
		closeModal()
		ok()
	}
}

function openLightbox(kind, src) {
	const lb = $('#lightbox')
	lb.innerHTML = `<div class="lb-bar"><a href="${src}?download=1" target="_blank">Скачать</a><button id="lb-close">Закрыть ✕</button></div>` + (kind === 'video' ? `<video src="${src}" controls autoplay playsinline></video>` : `<img src="${src}" alt="">`)
	show(lb)
	navPush('lightbox')
	$('#lb-close').onclick = closeLightbox
}
const closeLightbox = () => navClose('lightbox')
function _closeLightbox() {
	$('#lightbox').innerHTML = ''
	show($('#lightbox'), false)
}
$('#lightbox').addEventListener('click', (e) => e.target.id === 'lightbox' && closeLightbox())

// ============================================================ visibility → сервер (для «В сети» и автопрочтения)
function reportClient() {
	if (!socket?.connected) return
	socket.emit('client.state', { chatId: S.current, visible: document.visibilityState === 'visible' && document.hasFocus() })
}
document.addEventListener('visibilitychange', reportClient)
window.addEventListener('focus', reportClient)
window.addEventListener('blur', reportClient)

// ============================================================ theme
function localGet(k) {
	try {
		return localStorage.getItem(k)
	} catch {
		return null
	}
}
function localSet(k, v) {
	try {
		localStorage.setItem(k, v)
	} catch {}
}
function applyTheme() {
	const t = localGet('theme')
	if (t) document.documentElement.dataset.theme = t
	else delete document.documentElement.dataset.theme
}
applyTheme()

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {})

boot()
