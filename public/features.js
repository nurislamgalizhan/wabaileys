/* Дополнительные функции интерфейса: аккаунты, поиск, статусы, звонки, избранное,
   отложенные сообщения, автоответчик, профиль и приватность, группы, API. */
'use strict'

const ok = (r, msg) => {
	if (r?.error) toast(r.error)
	else if (msg) toast(msg)
	return !r?.error
}
const fmtDateTime = (ts) => `${fmtDay(ts)}, ${fmtTime(ts)}`
const phoneToJid = (p) => String(p).replace(/\D/g, '') + '@s.whatsapp.net'
const pickFile = (accept) =>
	new Promise((res) => {
		const i = document.createElement('input')
		i.type = 'file'
		i.accept = accept
		i.onchange = () => res(i.files[0] || null)
		i.click()
	})
function sel(id, value, options) {
	return `<select class="field" id="${id}">${options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`
}
function toggleRow(id, title, desc, checked) {
	return `<label class="setting"><div class="s-text"><div class="s-title">${title}</div>${desc ? `<div class="s-desc">${desc}</div>` : ''}</div>
		<span class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span></span></span></label>`
}
const saveSettings = (patch) => call('settings.set', patch).then((r) => ok(r))

// ============================================================ события
function onFeatureEvent(ev, p) {
	const kind = $('#drawer').dataset.kind
	if (ev === 'status.new') {
		if (!p?.fromMe) show($('#status-dot'))
		if (kind === 'statuses') openStatuses()
	}
	if (ev === 'call') {
		if (p.status === 'offer') toast(`${p.isVideo ? '📹' : '📞'} Входящий звонок: ${p.name}${p.rejected ? ' — отклонён автоматически' : ''}`, 6000)
		if (kind === 'calls') openCalls()
	}
	if (ev === 'scheduled.update' && kind === 'scheduled') openScheduled(S.scheduledChat)
	if (ev === 'bot.log') {
		if (p.error) toast('Автоответчик: ' + p.error, 5000)
		if (kind === 'bot') renderBotLog()
	}
}

// ============================================================ аккаунты
function accountName(a) {
	return a.label || a.me?.name || (a.me?.id ? '+' + a.me.id.split('@')[0] : 'Новый аккаунт')
}
function renderAccounts() {
	const others = (S.accounts || []).filter((a) => a.id !== S.acc)
	const unread = others.reduce((n, a) => n + (a.unread || 0), 0)
	const av = $('#me-avatar')
	if (av) {
		av.querySelector('.acc-badge')?.remove()
		if (unread) av.insertAdjacentHTML('beforeend', `<span class="acc-badge">${unread}</span>`)
		av.title = 'Аккаунты'
	}
	show($('#login-switch'), (S.accounts || []).length > 1)
}
function accountsMenu(x, y) {
	const items = (S.accounts || []).map((a) => [
		`${a.id === S.acc ? '✓ ' : ''}${accountName(a)}${a.unread && a.id !== S.acc ? ` (${a.unread})` : ''}${a.connection !== 'open' && a.me ? ' · нет связи' : ''}`,
		() => a.id !== S.acc && call('account.select', { id: a.id })
	])
	items.push(['＋ Добавить аккаунт', addAccountModal], ['Управление аккаунтами', openAccounts])
	menu(x, y, items)
}
$('.side-head').addEventListener('click', (e) => {
	if (!e.target.closest('#me-avatar')) return
	const r = $('#me-avatar').getBoundingClientRect()
	accountsMenu(r.left, r.bottom + 4)
})
$('#login-switch').addEventListener('click', (e) => {
	const r = e.currentTarget.getBoundingClientRect()
	accountsMenu(r.left, r.bottom + 4)
})
function addAccountModal() {
	modal(`<h3>Добавить аккаунт WhatsApp</h3>
		<p class="muted">Будет создан отдельный профиль: свои чаты, настройки приватности и автоответчик. Затем привяжите его по QR-коду или коду.</p>
		<input class="field" id="acc-label" type="text" placeholder="Название, например «Рабочий»" maxlength="40">
		<div class="actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="acc-go">Добавить</button></div>`)
	$('#acc-label').focus()
	$('#acc-go').onclick = async () => {
		const label = $('#acc-label').value
		closeModal()
		ok(await call('account.add', { label }))
	}
}
function openAccounts() {
	const list = S.accounts || []
	openDrawer(
		'accounts',
		'Аккаунты',
		list
			.map(
				(a) => `<div class="member">${avatarHTML(a.me?.id || a.id, accountName(a), 'sm')}
				<div style="flex:1;min-width:0"><div>${esc(accountName(a))}${a.id === S.acc ? ' <span class="muted">· открыт</span>' : ''}</div>
				<div class="muted" style="font-size:12px">${a.me?.id ? '+' + esc(a.me.id.split('@')[0]) : 'не привязан'} · ${a.connection === 'open' ? 'в сети' : a.me ? 'нет связи' : 'ожидает входа'}</div></div>
				<button class="btn small" data-acc-rename="${esc(a.id)}">Переименовать</button>
				${list.length > 1 ? `<button class="btn small danger" data-acc-remove="${esc(a.id)}">Удалить</button>` : ''}</div>`
			)
			.join('') + `<div style="margin-top:16px"><button class="btn primary" id="acc-add">＋ Добавить аккаунт</button></div>`
	)
	$('#acc-add').onclick = addAccountModal
	$('#drawer-body').onclick = (e) => {
		const rn = e.target.closest('[data-acc-rename]')
		const rm = e.target.closest('[data-acc-remove]')
		if (rn) {
			const a = list.find((x) => x.id === rn.dataset.accRename)
			promptModal('Название аккаунта', a.label || '', async (label) => ok(await call('account.rename', { id: a.id, label })) && setTimeout(openAccounts, 600))
		}
		if (rm) {
			const a = list.find((x) => x.id === rm.dataset.accRemove)
			confirmModal(`Удалить аккаунт «${accountName(a)}»? Устройство будет отвязано, история на сервере удалена.`, async () => {
				ok(await call('account.remove', { id: a.id }), 'Аккаунт удалён')
				setTimeout(openAccounts, 700)
			})
		}
	}
}

// ============================================================ главное меню
function mainMenu(e) {
	const r = e.currentTarget.getBoundingClientRect()
	menu(r.left - 180, r.bottom, [
		['⚙️ Настройки', () => openSettings()],
		['⭐ Избранное', openStarred],
		['📞 Звонки', openCalls],
		['⏰ Отложенные сообщения', () => openScheduled()],
		['🤖 Автоответчик', openBot],
		['🔌 API и вебхуки', openApi],
		['👥 Аккаунты', openAccounts]
	])
}
$('#btn-menu').addEventListener('click', mainMenu)
$('#btn-status').addEventListener('click', () => {
	show($('#status-dot'), false)
	openStatuses()
})

// ============================================================ поиск по сообщениям
let searchTimer
function searchMessages(q) {
	clearTimeout(searchTimer)
	if (q.trim().length < 2) {
		S.msgResults = null
		return renderChats()
	}
	searchTimer = setTimeout(async () => {
		const r = await call('search', { query: q })
		if (S.query !== q) return
		S.msgResults = r.results || []
		renderChats()
	}, 300)
}
function searchResultsHTML() {
	if (!S.msgResults || !S.query) return ''
	if (!S.msgResults.length) return '<div class="list-section">Сообщения</div><div class="list-empty">Ничего не найдено</div>'
	return (
		'<div class="list-section">Сообщения</div>' +
		S.msgResults
			.map(
				(r) => `<div class="result-item" data-result-chat="${esc(r.chatId)}" data-result-id="${esc(r.id)}">
				<div class="row"><div class="name">${esc(r.chatName)}</div><div class="time">${fmtListTime(r.ts)}</div></div>
				<div class="preview">${esc(r.snippet).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>')}</div></div>`
			)
			.join('')
	)
}
$('#chat-list').addEventListener('click', (e) => {
	const r = e.target.closest('[data-result-chat]')
	if (r) openChat(r.dataset.resultChat, r.dataset.resultId)
})

// ============================================================ меню чата
function chatMenuItems(id, withOpen) {
	const c = S.chats.get(id) || { id }
	const items = []
	if (withOpen) items.push(['Открыть', () => openChat(id)])
	items.push(c.unread ? ['Отметить прочитанным', () => markRead(id)] : ['Отметить непрочитанным', () => call('chat.unread', { chatId: id })])
	const act = (action, value, msg) => () => call('chat.action', { chatId: id, action, value }).then((r) => ok(r, msg))
	items.push([c.pinned ? 'Открепить' : 'Закрепить', act('pin', !c.pinned)])
	items.push([c.archived ? 'Вернуть из архива' : 'В архив', act('archive', !c.archived, c.archived ? 'Чат возвращён' : 'Чат в архиве')])
	if (c.muted) items.push(['Включить звук', act('mute', 0)])
	else items.push(['Без звука…', () => muteModal(id)])
	items.push(['Отложенные сообщения', () => openScheduled(id)])
	items.push(['Очистить чат', () => confirmModal('Удалить все сообщения в этом чате?', act('clear', true, 'Чат очищен'))])
	items.push(['Удалить чат', () => confirmModal('Удалить чат?', act('delete', true, 'Чат удалён'))])
	return items
}
function muteModal(id) {
	modal(`<h3>Без звука</h3>${sel('mute-dur', 28800, [
		[28800, '8 часов'],
		[604800, '1 неделя'],
		[-1, 'Всегда']
	])}<div class="actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="mute-go">OK</button></div>`)
	$('#mute-go').onclick = async () => {
		const value = Number($('#mute-dur').value)
		closeModal()
		ok(await call('chat.action', { chatId: id, action: 'mute', value }), 'Звук отключён')
	}
}

// ============================================================ простые модальные окна
function promptModal(title, value, onOk, { multiline = false, placeholder = '' } = {}) {
	modal(`<h3>${esc(title)}</h3>${multiline ? `<textarea class="field" id="pm-val" rows="4" placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input class="field" id="pm-val" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}">`}
		<div class="actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="pm-ok">Сохранить</button></div>`)
	const f = $('#pm-val')
	f.focus()
	const go = () => {
		const v = f.value
		closeModal()
		onOk(v)
	}
	$('#pm-ok').onclick = go
	if (!multiline) f.onkeydown = (e) => e.key === 'Enter' && go()
}

function editModal(m) {
	promptModal('Изменить сообщение', m.text || '', async (text) => {
		if (text.trim() && text !== m.text) ok(await call('message.edit', { chatId: m.chatId, msgId: m.id, text }))
	}, { multiline: true })
}
function editsModal(m) {
	if (!m?.edits?.length) return
	modal(`<h3>История правок</h3><div class="edits">${[...m.edits.map((e) => ({ ...e, old: true })), { text: m.text, ts: m.ts, old: false }]
		.map((e) => `<div class="edit-item ${e.old ? '' : 'current'}"><div class="muted">${e.old ? 'изменено ' + fmtDateTime(e.ts) : 'сейчас'}</div><div>${formatText(e.text || '')}</div></div>`)
		.join('')}</div><div class="actions"><button class="btn primary" data-close>Закрыть</button></div>`)
}

// выбор нескольких чатов/контактов
function pickerHTML(items) {
	return `<input class="field" id="pk-filter" type="search" placeholder="Поиск">
		<div class="picker" id="pk-list">${items
			.map((c) => `<label class="pick" data-name="${esc((c.name || '').toLowerCase())}"><input type="checkbox" value="${esc(c.id)}">${avatarHTML(c.id, c.name, 'sm')}<span>${esc(c.name)}</span></label>`)
			.join('')}</div>`
}
function bindPicker() {
	$('#pk-filter').oninput = (e) => {
		const q = e.target.value.toLowerCase()
		document.querySelectorAll('#pk-list .pick').forEach((el) => show(el, el.dataset.name.includes(q)))
	}
	return () => [...document.querySelectorAll('#pk-list input:checked')].map((i) => i.value)
}
function forwardModal(m) {
	const chats = [...S.chats.values()].filter((c) => c.last || c.isGroup).sort((a, b) => b.ts - a.ts)
	modal(`<h3>Переслать сообщение</h3>${pickerHTML(chats)}
		<div class="actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="fw-go">Переслать</button></div>`)
	const picked = bindPicker()
	$('#fw-go').onclick = async () => {
		const to = picked()
		if (!to.length) return toast('Выберите чаты')
		closeModal()
		ok(await call('message.forward', { chatId: m.chatId, msgId: m.id, to }), 'Переслано')
	}
}

// ============================================================ новый чат / группа
function newChatModal() {
	modal(`<h3>Новый чат</h3>
		<div class="row"><input class="field" id="new-phone" type="tel" placeholder="Номер, например +7 777 123 45 67"><button class="btn primary" id="new-go">Открыть</button></div>
		<p class="muted" id="new-check"></p>
		<div class="muted" style="font-size:13px">Или выберите контакт:</div>
		<div id="new-contacts"><div class="spinner" style="margin:12px auto"></div></div>
		<div class="actions"><button class="btn" data-close>Закрыть</button></div>`)
	$('#new-phone').focus()
	const go = async () => {
		const d = $('#new-phone').value.replace(/\D/g, '')
		if (d.length < 8) return toast('Введите номер полностью')
		$('#new-check').textContent = 'Проверяем номер…'
		const r = await call('numbers.check', { phones: [d] })
		const res = r.results?.[0]
		if (r.error) $('#new-check').textContent = 'Не удалось проверить номер: ' + r.error
		else if (res && !res.exists) return ($('#new-check').textContent = 'Этого номера нет в WhatsApp')
		const id = res?.jid || d + '@s.whatsapp.net'
		if (!S.chats.has(id)) S.chats.set(id, { id, name: '+' + d, phone: '+' + d, unread: 0, ts: Math.floor(Date.now() / 1000) })
		closeModal()
		openChat(id)
	}
	$('#new-go').onclick = go
	$('#new-phone').onkeydown = (e) => e.key === 'Enter' && go()
	call('contacts.list').then((r) => {
		const list = (r.contacts || []).filter((c) => !c.isGroup)
		const box = $('#new-contacts')
		if (!box) return
		box.innerHTML = `<input class="field" id="nc-filter" type="search" placeholder="Поиск контакта"><div class="picker">${list
			.map((c) => `<div class="pick" data-open="${esc(c.id)}" data-name="${esc(c.name.toLowerCase())}">${avatarHTML(c.id, c.name, 'sm')}<span>${esc(c.name)}</span></div>`)
			.join('')}</div>`
		$('#nc-filter').oninput = (e) => box.querySelectorAll('.pick').forEach((el) => show(el, el.dataset.name.includes(e.target.value.toLowerCase())))
		box.onclick = (e) => {
			const p = e.target.closest('[data-open]')
			if (!p) return
			const c = list.find((x) => x.id === p.dataset.open)
			if (!S.chats.has(c.id)) S.chats.set(c.id, { id: c.id, name: c.name, unread: 0, ts: Math.floor(Date.now() / 1000) })
			closeModal()
			openChat(c.id)
		}
	})
}
async function newGroupModal() {
	const r = await call('contacts.list')
	const list = (r.contacts || []).filter((c) => !c.isGroup)
	modal(`<h3>Новая группа</h3><input class="field" id="ng-name" type="text" placeholder="Название группы" maxlength="100">
		<input class="field" id="ng-phones" type="text" placeholder="Номера через запятую (необязательно)">
		<div class="muted" style="font-size:13px">Участники:</div>${pickerHTML(list)}
		<div class="actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="ng-go">Создать</button></div>`)
	const picked = bindPicker()
	$('#ng-name').focus()
	$('#ng-go').onclick = async () => {
		const subject = $('#ng-name').value.trim()
		const participants = [...picked(), ...$('#ng-phones').value.split(',').map((p) => p.replace(/\D/g, '')).filter((p) => p.length >= 8).map(phoneToJid)]
		if (!subject) return toast('Введите название')
		if (!participants.length) return toast('Добавьте хотя бы одного участника')
		closeModal()
		const res = await call('group.create', { subject, participants })
		if (ok(res, 'Группа создана')) setTimeout(() => openChat(res.chatId), 500)
	}
}
function joinGroupModal() {
	promptModal('Вступить в группу по ссылке', '', async (link) => {
		const r = await call('group.join', { link })
		if (ok(r, 'Вы вступили в группу') && r.chatId) setTimeout(() => openChat(r.chatId), 800)
	}, { placeholder: 'https://chat.whatsapp.com/…' })
}

// ============================================================ отложенные сообщения
function scheduleModal(chatId, text = '') {
	if (!chatId) return toast('Сначала откройте чат')
	const d = new Date(Date.now() + 3600_000)
	d.setSeconds(0, 0)
	const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
	modal(`<h3>Отложенное сообщение</h3><div class="muted">Чат: ${esc(S.chats.get(chatId)?.name || chatId)}</div>
		<textarea class="field" id="sc-text" rows="4" placeholder="Текст сообщения">${esc(text)}</textarea>
		<input class="field" id="sc-at" type="datetime-local" value="${local}">
		<p class="muted" style="font-size:12.5px;margin:0">Сообщение отправит сервер, даже если браузер закрыт. Нужно, чтобы сервер был запущен и подключён к WhatsApp.</p>
		<div class="actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="sc-go">Запланировать</button></div>`)
	$('#sc-text').focus()
	$('#sc-go').onclick = async () => {
		const at = new Date($('#sc-at').value).getTime()
		const r = await call('schedule.add', { chatId, text: $('#sc-text').value, at })
		if (ok(r, 'Сообщение запланировано на ' + fmtDateTime(at / 1000))) {
			closeModal()
			if (chatId === S.current && $('#sc-text')?.value === input.value) input.value = ''
			input.value = ''
			autosize()
		}
	}
}
async function openScheduled(chatId) {
	S.scheduledChat = chatId
	const r = await call('schedule.list', { chatId })
	const items = (r.items || []).sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || a.at - b.at)
	const label = { pending: '⏰ ожидает', sending: '… отправляется', sent: '✓ отправлено', error: '⚠ ошибка' }
	openDrawer(
		'scheduled',
		chatId ? 'Отложенные: ' + (S.chats.get(chatId)?.name || '') : 'Отложенные сообщения',
		(items.length
			? items
					.map(
						(s) => `<div class="card-item"><div class="row"><b style="flex:1">${esc(s.chatName)}</b><span class="muted">${fmtDateTime(s.at / 1000)}</span></div>
					<div class="ci-text">${esc(s.text)}</div>
					<div class="row"><span class="muted" style="flex:1">${label[s.status] || s.status}${s.error ? ': ' + esc(s.error) : ''}</span>
					<button class="btn small" data-sc-del="${s.id}">${s.status === 'pending' ? 'Отменить' : 'Убрать'}</button></div></div>`
					)
					.join('')
			: '<div class="list-empty">Нет отложенных сообщений</div>') +
			(chatId ? `<div style="margin-top:12px"><button class="btn primary" id="sc-new">＋ Запланировать</button></div>` : '')
	)
	if (chatId) $('#sc-new').onclick = () => scheduleModal(chatId)
	$('#drawer-body').onclick = async (e) => {
		const b = e.target.closest('[data-sc-del]')
		if (b) ok(await call('schedule.cancel', { id: Number(b.dataset.scDel) }))
	}
}

// ============================================================ избранное, звонки
async function openStarred() {
	openDrawer('starred', 'Избранные сообщения', '<div class="spinner" style="margin:20px auto"></div>')
	const r = await call('starred.list')
	const list = r.messages || []
	$('#drawer-body').innerHTML = list.length
		? list
				.map(
					(m) => `<div class="card-item clickable" data-go-chat="${esc(m.chatId)}" data-go-id="${esc(m.id)}">
				<div class="row"><b style="flex:1">${esc(S.chats.get(m.chatId)?.name || m.chatId)}</b><span class="muted">${fmtListTime(m.ts)}</span></div>
				<div class="ci-text">${m.fromMe ? 'Вы: ' : m.senderName ? esc(m.senderName) + ': ' : ''}${esc(m.text || { image: '📷 Фото', video: '🎥 Видео', audio: '🎤 Аудио', document: '📄 ' + (m.media?.fileName || ''), sticker: 'Стикер' }[m.type] || '')}</div></div>`
				)
				.join('')
		: '<div class="list-empty">Отметьте сообщение звёздочкой в его меню — оно появится здесь</div>'
	$('#drawer-body').onclick = (e) => {
		const g = e.target.closest('[data-go-chat]')
		if (g) openChat(g.dataset.goChat, g.dataset.goId)
	}
}
async function openCalls() {
	const r = await call('calls.list')
	const s = S.state.settings || {}
	const list = r.calls || []
	openDrawer(
		'calls',
		'Звонки',
		toggleRow('set-reject', 'Автоматически отклонять звонки', 'Baileys не умеет принимать звонки — можно сразу сбрасывать их и отвечать сообщением.', s.rejectCalls) +
			`<textarea class="field" id="set-reject-msg" rows="2" placeholder="Ответ после отклонения, например «Не могу говорить, напишите»">${esc(s.rejectMessage || '')}</textarea>
			<button class="btn small" id="save-reject-msg" style="margin-top:6px">Сохранить ответ</button>
			<div class="section-title">Журнал</div>` +
			(list.length
				? list
						.map(
							(c) => `<div class="member clickable" data-go-chat="${esc(c.from)}">${avatarHTML(c.from, c.name, 'sm')}
						<div style="flex:1;min-width:0"><div>${esc(c.name)}</div><div class="muted" style="font-size:12px">${c.isVideo ? '📹 видео' : '📞 аудио'}${c.isGroup ? ' · групповой' : ''} · ${fmtDateTime(c.ts)}</div></div>
						<span class="muted" style="font-size:12px">${c.rejected ? 'отклонён' : c.status === 'offer' || c.status === 'timeout' ? 'пропущен' : esc(c.status)}</span></div>`
						)
						.join('')
				: '<div class="list-empty">Звонков пока не было</div>')
	)
	$('#set-reject').onchange = (e) => saveSettings({ rejectCalls: e.target.checked })
	$('#save-reject-msg').onclick = () => saveSettings({ rejectMessage: $('#set-reject-msg').value }).then((x) => x && toast('Сохранено'))
	$('#drawer-body').onclick = (e) => {
		const g = e.target.closest('[data-go-chat]')
		if (g) openChat(g.dataset.goChat)
	}
}

// ============================================================ статусы
async function openStatuses() {
	const r = await call('statuses.list')
	S.statuses = r.statuses || []
	const s = S.state.settings || {}
	openDrawer(
		'statuses',
		'Статусы',
		toggleRow('set-status-rcpt', 'Отмечать статусы просмотренными', 'Если выключено, вы смотрите статусы незаметно: автор не увидит вас в списке просмотревших.', s.statusReceipts) +
			(S.statuses.length
				? S.statuses
						.map(
							(g, i) => `<div class="member clickable status-row" data-status="${i}"><div class="status-ring ${g.unseen ? 'unseen' : ''}">${avatarHTML(g.jid || 'me', g.name, 'sm')}</div>
						<div style="flex:1;min-width:0"><div>${esc(g.name)}</div><div class="muted" style="font-size:12px">${g.items.length} · ${fmtListTime(g.ts)}</div></div></div>`
						)
						.join('')
				: '<div class="list-empty">Статусов за последние 24 часа нет.<br>Новые статусы появятся здесь, пока клиент подключён.</div>')
	)
	$('#set-status-rcpt').onchange = (e) => saveSettings({ statusReceipts: e.target.checked })
	$('#drawer-body').onclick = (e) => {
		const row = e.target.closest('[data-status]')
		if (row) statusViewer(Number(row.dataset.status), 0)
	}
}
function statusViewer(gi, ii) {
	const g = S.statuses?.[gi]
	if (!g) return closeLightbox()
	const item = g.items[ii]
	if (!item) return statusViewer(gi + 1, 0)
	clearTimeout(S.svTimer)
	const lb = $('#lightbox')
	const src = mediaUrl(item)
	let content
	if (item.type === 'image' || item.type === 'sticker') content = `<img src="${src}" alt="">`
	else if (item.type === 'video') content = `<video src="${src}" autoplay playsinline></video>`
	else content = `<div class="status-text" style="background:${item.bg || '#2c3a42'};color:${item.fg || '#fff'}">${formatText(item.text || '')}</div>`
	lb.innerHTML = `<div class="sv-bars">${g.items.map((_, i) => `<span class="${i < ii ? 'done' : i === ii ? 'cur' : ''}"></span>`).join('')}</div>
		<div class="sv-head">${avatarHTML(g.jid || 'me', g.name, 'sm')}<div><b>${esc(g.name)}</b><div class="muted">${fmtDateTime(item.ts)}</div></div><span class="spacer"></span><button id="sv-close">✕</button></div>
		<div class="sv-body">${content}${item.text && item.type !== 'text' ? `<div class="sv-caption">${formatText(item.text)}</div>` : ''}</div>
		<div class="sv-nav"><div data-sv="prev"></div><div data-sv="next"></div></div>`
	show(lb)
	lb.classList.add('status-mode')
	navPush('lightbox')
	if (!item.seen) {
		item.seen = true
		call('status.view', { id: item.id })
	}
	const next = () => (ii + 1 < g.items.length ? statusViewer(gi, ii + 1) : statusViewer(gi + 1, 0))
	const prev = () => (ii > 0 ? statusViewer(gi, ii - 1) : gi > 0 ? statusViewer(gi - 1, 0) : null)
	const bar = lb.querySelector('.sv-bars .cur')
	const video = lb.querySelector('video')
	if (video) {
		video.onended = next
		video.ontimeupdate = () => bar && (bar.style.setProperty('--p', (video.currentTime / (video.duration || 1)) * 100 + '%'))
	} else {
		bar?.classList.add('anim')
		S.svTimer = setTimeout(() => !lb.classList.contains('hidden') && next(), 5000)
	}
	$('#sv-close').onclick = () => {
		clearTimeout(S.svTimer)
		closeLightbox()
		if ($('#drawer').dataset.kind === 'statuses') openStatuses()
	}
	lb.querySelector('[data-sv="next"]').onclick = next
	lb.querySelector('[data-sv="prev"]').onclick = prev
}

// ============================================================ настройки и профиль
async function openSettings(refreshOnly) {
	const s = S.state.settings || {}
	if (refreshOnly) {
		for (const [id, k] of [['set-online', 'online'], ['set-read', 'readReceipts'], ['set-status', 'statusReceipts'], ['set-keep', 'keepDeleted']]) {
			const el = document.getElementById(id)
			if (el) el.checked = !!s[k]
		}
		return
	}
	const me = S.state.me || {}
	openDrawer(
		'settings',
		'Настройки',
		`<div class="profile-head"><div class="avatar-edit" id="me-photo" title="Сменить фото">${avatarHTML(me.id || 'me', me.name, 'xl')}<span>📷</span></div>
			<h2 id="me-name">${esc(me.name || '')} <button class="link-btn" id="edit-name">✎</button></h2>
			<div class="muted">${me.id ? '+' + esc(me.id.split('@')[0]) : ''}</div>
			<div class="about" id="me-about"><span class="muted">Загрузка…</span></div></div>
		<div class="section-title">Приватность этого клиента</div>
		${toggleRow('set-online', 'Показывать «В сети»', 'Выключено — клиент никогда не сообщает WhatsApp, что вы онлайн, и не показывает «печатает…». Открытое приложение на телефоне по-прежнему показывает вас в сети.', s.online)}
		${toggleRow('set-read', 'Отправлять отчёты о прочтении', 'Выключено — открытие чата не ставит синие галочки, голосовые не отмечаются прослушанными. Прочитать вручную — кнопкой в шапке чата.', s.readReceipts)}
		${toggleRow('set-status', 'Отмечать статусы просмотренными', 'Выключено — статусы можно смотреть незаметно.', s.statusReceipts)}
		${toggleRow('set-keep', 'Сохранять удалённые сообщения', 'Если собеседник удалит сообщение у всех, здесь останется его текст и медиа с пометкой «удалено». Работает для сообщений, полученных, пока клиент подключён.', s.keepDeleted)}
		<div class="section-title">Приватность аккаунта WhatsApp</div>
		<p class="muted" style="font-size:12.5px;margin:4px 0">Эти настройки меняются для всего аккаунта, в том числе на телефоне.</p>
		<div id="acc-privacy"><div class="spinner" style="margin:12px auto"></div></div>
		<div class="section-title">Инструменты</div>
		<div class="tools">
			<button class="btn" data-tool="bot">🤖 Автоответчик</button><button class="btn" data-tool="scheduled">⏰ Отложенные</button>
			<button class="btn" data-tool="starred">⭐ Избранное</button><button class="btn" data-tool="calls">📞 Звонки</button>
			<button class="btn" data-tool="api">🔌 API и вебхуки</button><button class="btn" data-tool="accounts">👥 Аккаунты</button>
		</div>
		<div class="section-title">Оформление</div>
		<div class="setting"><div class="s-text"><div class="s-title">Тема</div></div>
			${sel('set-theme', localGet('theme') || '', [['', 'Системная'], ['light', 'Светлая'], ['dark', 'Тёмная']])}</div>
		<div style="margin-top:24px"><button class="btn danger" id="btn-logout">Выйти из этого аккаунта WhatsApp</button></div>`
	)
	$('#set-online').onchange = (e) => saveSettings({ online: e.target.checked })
	$('#set-read').onchange = (e) => saveSettings({ readReceipts: e.target.checked })
	$('#set-status').onchange = (e) => saveSettings({ statusReceipts: e.target.checked })
	$('#set-keep').onchange = (e) => saveSettings({ keepDeleted: e.target.checked })
	$('#set-theme').onchange = (e) => {
		localSet('theme', e.target.value)
		applyTheme()
	}
	const tools = { bot: openBot, scheduled: () => openScheduled(), starred: openStarred, calls: openCalls, api: openApi, accounts: openAccounts }
	document.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => tools[b.dataset.tool]()))
	$('#btn-logout').onclick = () =>
		confirmModal('Выйти из аккаунта? Устройство будет отвязано, локальная история удалена.', async () => {
			await call('logout')
			closeDrawer()
		})
	$('#edit-name').onclick = () => promptModal('Ваше имя', S.state.me?.name || '', async (name) => ok(await call('profile.set', { name }), 'Имя изменено') && openSettings())
	$('#me-photo').onclick = () =>
		menu(innerWidth / 2 - 90, 200, [
			['Загрузить фото', async () => {
				const f = await pickFile('image/*')
				if (!f) return
				toast('Загрузка…')
				ok(await call('profile.set', { photo: await f.arrayBuffer() }), 'Фото обновлено')
			}],
			['Удалить фото', async () => ok(await call('profile.set', { removePhoto: true }), 'Фото удалено')]
		])
	loadProfile()
}
async function loadProfile() {
	const r = await call('profile.get')
	if ($('#drawer').dataset.kind !== 'settings') return
	if (r.error) {
		$('#me-about').innerHTML = ''
		$('#acc-privacy').innerHTML = `<p class="muted">Недоступно: ${esc(r.error)}</p>`
		return
	}
	const p = r.profile
	$('#me-about').innerHTML = `${esc(p.about || 'Сведения не указаны')} <button class="link-btn" id="edit-about">✎</button>`
	$('#edit-about').onclick = () => promptModal('Сведения («О себе»)', p.about || '', async (about) => ok(await call('profile.set', { about }), 'Сохранено') && loadProfile())
	const pv = p.privacy || {}
	const who = [['all', 'Все'], ['contacts', 'Мои контакты'], ['contact_blacklist', 'Мои контакты, кроме…'], ['none', 'Никто']]
	const rows = [
		['last', 'Был(а) недавно', who],
		['online', 'Кто видит, что я в сети', [['all', 'Все'], ['match_last_seen', 'Как «Был(а) недавно»']]],
		['profile', 'Фото профиля', who],
		['status', 'Сведения', who],
		['readreceipts', 'Отчёты о прочтении (аккаунт)', [['all', 'Включены'], ['none', 'Выключены']]],
		['groupadd', 'Кто может добавлять в группы', who.slice(0, 3)],
		['calladd', 'Кто может звонить', [['all', 'Все'], ['known', 'Только известные']]],
		['messages', 'Кто может писать', [['all', 'Все'], ['contacts', 'Только контакты']]]
	]
	$('#acc-privacy').innerHTML =
		rows.map(([k, t, opts]) => `<div class="setting"><div class="s-text"><div class="s-title">${t}</div></div>${sel('pv-' + k, pv[k] || '', [['', '—'], ...opts])}</div>`).join('') +
		`<div class="setting"><div class="s-text"><div class="s-title">Исчезающие сообщения по умолчанию</div><div class="s-desc">Для новых чатов</div></div>${sel('pv-disappearing', '', [['', '—'], [0, 'Выкл.'], [86400, '24 часа'], [604800, '7 дней'], [7776000, '90 дней']])}</div>`
	for (const [k] of [...rows, ['disappearing']]) {
		$('#pv-' + k).onchange = async (e) => {
			if (e.target.value === '') return
			ok(await call('privacy.set', { key: k, value: e.target.value }), 'Сохранено')
		}
	}
}

// ============================================================ информация о чате / группе
async function openInfo() {
	const id = S.current
	if (!id) return
	const c = S.chats.get(id) || { id, name: id }
	if (!c.isGroup) {
		openDrawer('info', 'Данные контакта', `<div class="profile-head">${avatarHTML(c.id, c.name, 'xl')}<h2>${esc(c.name)}</h2><div class="muted">${esc(c.phone || id)}</div></div><div class="spinner" style="margin:20px auto"></div>`)
		const r = await call('contact.info', { jid: id })
		if (S.current !== id || $('#drawer').dataset.kind !== 'info') return
		const ci = r.contact || {}
		$('#drawer-body').innerHTML = `<div class="profile-head">${avatarHTML(c.id, c.name, 'xl')}<h2>${esc(c.name)}</h2><div class="muted">${esc(ci.phone || c.phone || id)}</div></div>
			<div class="section-title">Сведения</div><div>${esc(ci.about || '—')}</div>
			${ci.business ? `<div class="section-title">Бизнес-профиль</div><div>${esc(ci.business.category || '')}</div><div class="muted">${esc(ci.business.description || '')}</div>${ci.business.website ? `<a href="${esc(ci.business.website)}" target="_blank" rel="noopener">${esc(ci.business.website)}</a>` : ''}${ci.business.address ? `<div class="muted">${esc(ci.business.address)}</div>` : ''}` : ''}
			<div class="section-title">Действия</div>
			<div class="tools">
				<button class="btn" id="ci-sched">⏰ Отложенные</button>
				<button class="btn" id="ci-clear">🧹 Очистить чат</button>
				<button class="btn danger" id="ci-block">${ci.blocked ? 'Разблокировать' : '🚫 Заблокировать'}</button>
			</div>`
		$('#ci-sched').onclick = () => openScheduled(id)
		$('#ci-clear').onclick = () => confirmModal('Удалить все сообщения в этом чате?', () => call('chat.action', { chatId: id, action: 'clear' }).then((r) => ok(r, 'Чат очищен')))
		$('#ci-block').onclick = () =>
			confirmModal(ci.blocked ? 'Разблокировать контакт?' : 'Заблокировать контакт? Он не сможет писать и звонить вам.', async () => {
				ok(await call('chat.action', { chatId: id, action: ci.blocked ? 'unblock' : 'block' }), ci.blocked ? 'Разблокирован' : 'Заблокирован')
				openInfo()
			})
		return
	}
	openDrawer('info', 'Данные группы', `<div class="profile-head">${avatarHTML(c.id, c.name, 'xl')}<h2>${esc(c.name)}</h2></div><div class="spinner" style="margin:20px auto"></div>`)
	const r = await call('group.info', { chatId: id })
	const g = r.group
	if (!g || S.current !== id || $('#drawer').dataset.kind !== 'info') return
	S.group = g
	const meId = S.state.me?.id
	const amAdmin = !!g.participants.find((p) => p.id === meId)?.admin
	const ga = (action, payload, msg) => call('group.action', { chatId: id, action, payload }).then((r) => {
		if (r.failed?.length) toast('Не удалось для: ' + r.failed.map((f) => f.jid.split('@')[0]).join(', '))
		else ok(r, msg)
		return r
	})
	$('#drawer-body').innerHTML = `<div class="profile-head"><div class="${amAdmin ? 'avatar-edit' : ''}" id="g-photo">${avatarHTML(c.id, c.name, 'xl')}${amAdmin ? '<span>📷</span>' : ''}</div>
			<h2>${esc(g.subject || c.name)} ${amAdmin ? '<button class="link-btn" id="g-subject">✎</button>' : ''}</h2>
			<div class="muted">Группа · ${g.participants.length} участник(ов)</div></div>
		<div class="section-title">Описание ${amAdmin ? '<button class="link-btn" id="g-desc">✎</button>' : ''}</div><div style="white-space:pre-wrap">${g.desc ? formatText(g.desc) : '<span class="muted">—</span>'}</div>
		<div class="section-title">Участники</div>
		${amAdmin ? '<button class="btn small" id="g-add" style="margin-bottom:6px">＋ Добавить участников</button>' : ''}
		${g.participants
			.sort((a, b) => !!b.admin - !!a.admin)
			.map((p) => `<div class="member ${amAdmin && p.id !== meId ? 'clickable' : ''}" data-member="${esc(p.id)}">${avatarHTML(p.id, p.name, 'sm')}<div style="flex:1;min-width:0">${esc(p.name)}<div class="muted" style="font-size:12px">${p.id.endsWith('@s.whatsapp.net') ? '+' + esc(p.id.split('@')[0]) : ''}</div></div>${p.admin ? '<span class="admin">админ</span>' : ''}</div>`)
			.join('')}
		<div class="section-title">Действия</div>
		<div class="tools">
			${amAdmin ? '<button class="btn" id="g-link">🔗 Ссылка-приглашение</button><button class="btn" id="g-settings">⚙️ Права участников</button>' : ''}
			<button class="btn" id="g-sched">⏰ Отложенные</button>
			<button class="btn danger" id="g-leave">Выйти из группы</button>
		</div>`
	$('#g-sched').onclick = () => openScheduled(id)
	$('#g-leave').onclick = () => confirmModal('Выйти из группы?', () => ga('leave', {}, 'Вы вышли из группы'))
	if (!amAdmin) return
	$('#g-subject').onclick = () => promptModal('Название группы', g.subject || '', (subject) => ga('subject', { subject }, 'Название изменено').then(() => setTimeout(openInfo, 600)))
	$('#g-desc').onclick = () => promptModal('Описание группы', g.desc || '', (description) => ga('description', { description }, 'Описание изменено').then(() => setTimeout(openInfo, 600)), { multiline: true })
	$('#g-photo').onclick = async () => {
		const f = await pickFile('image/*')
		if (f) ga('photo', { photo: await f.arrayBuffer() }, 'Фото группы обновлено')
	}
	$('#g-add').onclick = async () => {
		const r = await call('contacts.list')
		const inGroup = new Set(g.participants.map((p) => p.id))
		modal(`<h3>Добавить участников</h3><input class="field" id="ga-phones" type="text" placeholder="Номера через запятую">${pickerHTML((r.contacts || []).filter((c) => !c.isGroup && !inGroup.has(c.id)))}
			<div class="actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="ga-go">Добавить</button></div>`)
		const picked = bindPicker()
		$('#ga-go').onclick = async () => {
			const participants = [...picked(), ...$('#ga-phones').value.split(',').map((p) => p.replace(/\D/g, '')).filter((p) => p.length >= 8).map(phoneToJid)]
			if (!participants.length) return toast('Выберите участников')
			closeModal()
			await ga('add', { participants }, 'Участники добавлены')
			setTimeout(openInfo, 800)
		}
	}
	$('#g-link').onclick = async () => {
		const r = await ga('invite', {})
		if (!r.link) return
		modal(`<h3>Ссылка-приглашение</h3><input class="field" id="gl-link" type="text" readonly value="${esc(r.link)}">
			<div class="actions"><button class="btn danger" id="gl-revoke">Сбросить ссылку</button><button class="btn" data-close>Закрыть</button><button class="btn primary" id="gl-copy">Копировать</button></div>`)
		$('#gl-copy').onclick = () => navigator.clipboard?.writeText($('#gl-link').value).then(() => toast('Скопировано'))
		$('#gl-revoke').onclick = async () => {
			const x = await ga('revoke', {}, 'Старая ссылка больше не работает')
			if (x.link) $('#gl-link').value = x.link
		}
	}
	$('#g-settings').onclick = () => {
		modal(`<h3>Права участников</h3>
			<div class="setting"><div class="s-text"><div class="s-title">Отправлять сообщения</div></div>${sel('gs-announce', g.announce ? 'announcement' : 'not_announcement', [['not_announcement', 'Все участники'], ['announcement', 'Только админы']])}</div>
			<div class="setting"><div class="s-text"><div class="s-title">Менять данные группы</div></div>${sel('gs-locked', g.restrict ? 'locked' : 'unlocked', [['unlocked', 'Все участники'], ['locked', 'Только админы']])}</div>
			<div class="actions"><button class="btn primary" data-close>Готово</button></div>`)
		$('#gs-announce').onchange = (e) => ga('setting', { setting: e.target.value }, 'Сохранено')
		$('#gs-locked').onchange = (e) => ga('setting', { setting: e.target.value }, 'Сохранено')
	}
	$('#drawer-body').onclick = (e) => {
		const m = e.target.closest('.member.clickable[data-member]')
		if (!m) return
		const p = g.participants.find((x) => x.id === m.dataset.member)
		menu(e.clientX, e.clientY, [
			['Написать', () => openChat(p.id)],
			p.admin ? ['Снять права админа', () => ga('demote', { participants: [p.id] }, 'Готово').then(() => setTimeout(openInfo, 600))] : ['Сделать админом', () => ga('promote', { participants: [p.id] }, 'Готово').then(() => setTimeout(openInfo, 600))],
			['Удалить из группы', () => confirmModal(`Удалить ${p.name} из группы?`, () => ga('remove', { participants: [p.id] }, 'Удалён').then(() => setTimeout(openInfo, 600)))]
		])
	}
}

// ============================================================ автоответчик
async function openBot() {
	const r = await call('rules.list')
	S.rules = r.rules || []
	S.botLog = r.log || []
	const s = S.state.settings || {}
	const desc = (x) => {
		const m = { any: 'на любое сообщение', contains: `содержит «${x.pattern}»`, exact: `точно «${x.pattern}»`, regex: `regex /${x.pattern}/` }[x.match] || ''
		const sc = { private: 'личные', groups: 'группы', all: 'все чаты' }[x.scope || 'private']
		return `${m} · ${sc} · ${x.ai ? '🧠 ответ Claude' : '«' + (x.reply || '').slice(0, 40) + '»'}${x.onlyAway ? ' · когда меня нет' : ''}${x.cooldownMin ? ` · не чаще раза в ${x.cooldownMin} мин` : ''}`
	}
	openDrawer(
		'bot',
		'Автоответчик',
		toggleRow('bot-on', 'Автоответчик включён', 'Срабатывает первое подходящее правило сверху вниз. Работает на сервере, даже когда браузер закрыт.', s.botEnabled) +
			`<div class="section-title">Правила</div>
		${S.rules.length ? S.rules.map((x) => `<div class="card-item"><div class="row"><b style="flex:1">${esc(x.name || 'Правило #' + x.id)}</b>
			<span class="switch"><input type="checkbox" data-rule-on="${x.id}" ${x.enabled ? 'checked' : ''}><span></span></span></div>
			<div class="muted" style="font-size:12.5px">${esc(desc(x))}</div>
			<div class="row" style="justify-content:flex-end;gap:6px"><button class="btn small" data-rule-edit="${x.id}">Изменить</button><button class="btn small danger" data-rule-del="${x.id}">Удалить</button></div></div>`).join('') : '<div class="list-empty">Правил пока нет</div>'}
		<button class="btn primary" id="rule-add">＋ Добавить правило</button>
		<div class="section-title">Claude (ответы с ИИ)</div>
		<p class="muted" style="font-size:12.5px;margin:4px 0">Для правил с ИИ: Claude отвечает с учётом последних 30 сообщений чата. Нужен ключ API с <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a> (или переменная ANTHROPIC_API_KEY на сервере).</p>
		<div class="row"><input class="field" id="ai-key" type="password" autocomplete="off" placeholder="${S.state.hasAiKey ? 'Ключ задан — введите новый, чтобы заменить' : 'sk-ant-…'}"><button class="btn small" id="ai-key-save">Сохранить</button></div>
		<div class="row" style="margin-top:6px"><input class="field" id="ai-model" type="text" value="${esc(s.aiModel || 'claude-opus-5-5')}"><button class="btn small" id="ai-model-save">Модель</button></div>
		<div class="section-title">Журнал</div><div id="bot-log"></div>`
	)
	renderBotLog()
	$('#bot-on').onchange = (e) => saveSettings({ botEnabled: e.target.checked })
	$('#rule-add').onclick = () => ruleModal({ enabled: true, match: 'contains', scope: 'private', cooldownMin: 60 })
	$('#ai-key-save').onclick = async () => {
		if (ok(await call('settings.set', { aiKey: $('#ai-key').value }), 'Ключ сохранён')) $('#ai-key').value = ''
	}
	$('#ai-model-save').onclick = () => saveSettings({ aiModel: $('#ai-model').value }).then((x) => x && toast('Модель сохранена'))
	$('#drawer-body').onclick = async (e) => {
		const ed = e.target.closest('[data-rule-edit]')
		const del = e.target.closest('[data-rule-del]')
		if (ed) ruleModal(S.rules.find((x) => x.id === Number(ed.dataset.ruleEdit)))
		if (del) confirmModal('Удалить правило?', async () => ok(await call('rules.delete', { id: Number(del.dataset.ruleDel) })) && openBot())
	}
	$('#drawer-body').onchange = async (e) => {
		const on = e.target.closest('[data-rule-on]')
		if (!on) return
		const rule = S.rules.find((x) => x.id === Number(on.dataset.ruleOn))
		ok(await call('rules.save', { rule: { ...rule, enabled: on.checked } }))
	}
}
function renderBotLog() {
	const box = $('#bot-log')
	if (!box) return
	const log = S.botLog || []
	box.innerHTML = log.length
		? log.map((l) => `<div class="log-item ${l.error ? 'err' : ''}"><span class="muted">${fmtTime(l.at / 1000)}</span> <b>${esc(l.chat)}</b> · ${esc(l.rule)}<div>${esc(l.error || l.text)}</div></div>`).join('')
		: '<div class="muted">Пока пусто</div>'
}
socketReady(() => socket.on('bot.log', (l) => (S.botLog = [l, ...(S.botLog || [])].slice(0, 50))))
function ruleModal(rule) {
	modal(`<h3>${rule.id ? 'Изменить правило' : 'Новое правило'}</h3>
		<input class="field" id="r-name" type="text" placeholder="Название (для себя)" value="${esc(rule.name || '')}">
		<div class="row">${sel('r-match', rule.match || 'contains', [['contains', 'Содержит слова'], ['exact', 'Точное совпадение'], ['regex', 'Регулярное выражение'], ['any', 'Любое сообщение']])}
			${sel('r-scope', rule.scope || 'private', [['private', 'Личные чаты'], ['groups', 'Группы'], ['all', 'Все чаты']])}</div>
		<input class="field" id="r-pattern" type="text" placeholder="Слова через запятую, например: цена, прайс, сколько стоит" value="${esc(rule.pattern || '')}">
		<label class="chk"><input type="checkbox" id="r-ai" ${rule.ai ? 'checked' : ''}> Отвечать с помощью Claude (ИИ)</label>
		<textarea class="field" id="r-reply" rows="3" placeholder="Текст ответа">${esc(rule.reply || '')}</textarea>
		<textarea class="field" id="r-prompt" rows="4" placeholder="Инструкция для Claude: кто вы, что можно рассказывать, тон. Например: «Я фотограф. Съёмка стоит от 30 000 тг, запись через этот чат. Если спрашивают свободные даты — скажи, что уточню и отвечу вечером.»">${esc(rule.aiPrompt || '')}</textarea>
		<div class="row"><label class="muted" style="font-size:13px;flex:1">Не чаще раза в (мин) в одном чате<input class="field" id="r-cd" type="number" min="0" value="${rule.cooldownMin ?? 60}"></label>
			<label class="muted" style="font-size:13px;flex:1">Задержка ответа (сек)<input class="field" id="r-delay" type="number" min="0" max="120" value="${rule.delaySec ?? 0}"></label></div>
		<label class="chk"><input type="checkbox" id="r-away" ${rule.onlyAway ? 'checked' : ''}> Только когда этот клиент не открыт</label>
		<label class="chk"><input type="checkbox" id="r-quote" ${rule.quote ? 'checked' : ''}> Отвечать цитатой</label>
		<div class="actions"><button class="btn" data-close>Отмена</button><button class="btn primary" id="r-save">Сохранить</button></div>`)
	const sync = () => {
		const ai = $('#r-ai').checked
		show($('#r-reply'), !ai)
		show($('#r-prompt'), ai)
		show($('#r-pattern'), $('#r-match').value !== 'any')
	}
	$('#r-ai').onchange = sync
	$('#r-match').onchange = sync
	sync()
	$('#r-save').onclick = async () => {
		const next = {
			...rule,
			name: $('#r-name').value.trim(),
			match: $('#r-match').value,
			scope: $('#r-scope').value,
			pattern: $('#r-pattern').value.trim(),
			ai: $('#r-ai').checked,
			reply: $('#r-reply').value.trim(),
			aiPrompt: $('#r-prompt').value.trim(),
			cooldownMin: Math.max(0, Number($('#r-cd').value) || 0),
			delaySec: Math.min(120, Math.max(0, Number($('#r-delay').value) || 0)),
			onlyAway: $('#r-away').checked,
			quote: $('#r-quote').checked
		}
		if (next.match !== 'any' && !next.pattern) return toast('Укажите слова или выражение')
		if (!next.ai && !next.reply) return toast('Введите текст ответа')
		if (next.match === 'regex') {
			try {
				new RegExp(next.pattern)
			} catch {
				return toast('Ошибка в регулярном выражении')
			}
		}
		if (ok(await call('rules.save', { rule: next }), 'Правило сохранено')) {
			closeModal()
			openBot()
		}
	}
}

// ============================================================ API и вебхуки
async function openApi() {
	const r = await call('api.info')
	const s = S.state.settings || {}
	const base = location.origin + '/api/v1'
	openDrawer(
		'api',
		'API и вебхуки',
		`<p class="muted" style="font-size:13px">HTTP API позволяет отправлять сообщения и читать чаты из своих программ, CRM, n8n и т. п. Токен общий для всех аккаунтов — храните его в секрете.</p>
		<div class="section-title">Токен</div>
		<div class="row"><input class="field" id="api-token" type="password" readonly value="${esc(r.token || '')}"><button class="btn small" id="api-show">👁</button><button class="btn small" id="api-copy">Копировать</button></div>
		<button class="btn small danger" id="api-regen" style="margin-top:6px">Создать новый токен</button>
		<div class="section-title">Примеры (аккаунт «${esc(S.acc)}»)</div>
		<pre class="code">curl -H "Authorization: Bearer $TOKEN" \\
  ${esc(base)}/${esc(S.acc)}/chats

curl -X POST -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"77011234567","text":"Привет!"}' \\
  ${esc(base)}/${esc(S.acc)}/messages

# отложенная отправка: добавьте "at":"2026-12-31T10:00:00+05:00"
# поиск: GET ${esc(base)}/${esc(S.acc)}/search?q=слово
# список аккаунтов: GET ${esc(base)}/accounts</pre>
		<div class="section-title">Вебхук</div>
		<p class="muted" style="font-size:13px">На этот адрес сервер отправит POST с JSON о каждом новом сообщении этого аккаунта. Заголовок <code>X-Signature</code> — HMAC-SHA256 тела, ключ — токен API.</p>
		<div class="row"><input class="field" id="wh-url" type="url" placeholder="https://example.com/whatsapp-webhook" value="${esc(s.webhookUrl || '')}"><button class="btn small" id="wh-save">Сохранить</button></div>`
	)
	$('#api-show').onclick = () => ($('#api-token').type = $('#api-token').type === 'password' ? 'text' : 'password')
	$('#api-copy').onclick = () => navigator.clipboard?.writeText($('#api-token').value).then(() => toast('Скопировано'))
	$('#api-regen').onclick = () =>
		confirmModal('Создать новый токен? Старый перестанет работать.', async () => {
			const x = await call('api.regenerate')
			if (ok(x, 'Новый токен создан')) $('#api-token').value = x.token
		})
	$('#wh-save').onclick = () => saveSettings({ webhookUrl: $('#wh-url').value }).then((x) => x && toast('Сохранено'))
}

// ============================================================ запуск
function socketReady(fn) {
	if (socket) fn()
	else (socketReady.q = socketReady.q || []).push(fn)
}
const _connect = connect
connect = function () {
	_connect()
	for (const fn of socketReady.q || []) fn()
	socketReady.q = []
}
boot()
