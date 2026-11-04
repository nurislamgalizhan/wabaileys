// Преобразование WAMessage (Baileys) в компактный объект для веб-клиента
import { normalizeMessageContent, getContentType, toNumber, WAMessageStubType } from 'baileys'

const MEDIA_TYPES = {
	imageMessage: 'image',
	videoMessage: 'video',
	ptvMessage: 'video',
	audioMessage: 'audio',
	documentMessage: 'document',
	stickerMessage: 'sticker'
}

// Сообщения, которые не нужно показывать отдельным пузырём
const HIDDEN_TYPES = new Set([
	'protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'pollUpdateMessage',
	'messageContextInfo', 'keepInChatMessage', 'encReactionMessage', 'encEventResponseMessage',
	'pinInChatMessage', 'secretEncryptedMessage'
])

const argb = (n) => {
	const v = Number(n) >>> 0
	return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${(((v >>> 24) & 255) / 255).toFixed(2)})`
}

// текст для полнотекстового поиска
export function searchText(msg) {
	const d = serializeContent(msg)
	if (!d || d.type === 'system') return null
	return [d.text, d.media?.fileName, d.poll?.name, ...(d.poll?.options || []), d.location?.name, d.location?.address, d.contact?.name]
		.filter(Boolean)
		.join(' ')
		.slice(0, 4000) || null
}

const b64 = (buf) => (buf && buf.length ? Buffer.from(buf).toString('base64') : undefined)

export const msgTimestamp = (m) => toNumber(m.messageTimestamp) || 0

export function unwrap(message) {
	let content = normalizeMessageContent(message)
	if (content?.documentWithCaptionMessage) content = content.documentWithCaptionMessage.message
	if (content?.editedMessage) content = normalizeMessageContent(content.editedMessage.message)
	return content
}

export function contentType(message) {
	const content = unwrap(message)
	if (!content) return undefined
	return getContentType(content)
}

// Короткое текстовое описание сообщения (для превью чата и цитат)
export function previewText(msg) {
	const d = serializeContent(msg)
	if (!d) return ''
	if (d.deleted) return '🚫 Сообщение удалено'
	switch (d.type) {
		case 'image': return '📷 ' + (d.text || 'Фото')
		case 'video': return '🎥 ' + (d.text || (d.media?.gif ? 'GIF' : 'Видео'))
		case 'audio': return d.media?.ptt ? '🎤 Голосовое сообщение' : '🎵 Аудио'
		case 'document': return '📄 ' + (d.media?.fileName || 'Документ')
		case 'sticker': return '💟 Стикер'
		case 'location': return '📍 Геолокация'
		case 'contact': return '👤 ' + (d.contact?.name || 'Контакт')
		case 'poll': return '📊 ' + (d.poll?.name || 'Опрос')
		case 'call': return '📞 Звонок'
		case 'system': return d.text || ''
		default: return d.text || ''
	}
}

const STUB_TEXT = {
	[WAMessageStubType.GROUP_CREATE]: (p) => `создал(а) группу «${p[0] || ''}»`,
	[WAMessageStubType.GROUP_CHANGE_SUBJECT]: (p) => `изменил(а) название на «${p[0] || ''}»`,
	[WAMessageStubType.GROUP_CHANGE_ICON]: () => 'изменил(а) фото группы',
	[WAMessageStubType.GROUP_CHANGE_DESCRIPTION]: () => 'изменил(а) описание группы',
	[WAMessageStubType.GROUP_PARTICIPANT_ADD]: (p, n) => `добавил(а) ${p.map(n).join(', ')}`,
	[WAMessageStubType.GROUP_PARTICIPANT_REMOVE]: (p, n) => `удалил(а) ${p.map(n).join(', ')}`,
	[WAMessageStubType.GROUP_PARTICIPANT_LEAVE]: (p, n) => `${p.map(n).join(', ')} вышел(а) из группы`,
	[WAMessageStubType.GROUP_PARTICIPANT_INVITE]: (p, n) => `${p.map(n).join(', ')} присоединился(-ась) по ссылке`,
	[WAMessageStubType.GROUP_PARTICIPANT_PROMOTE]: (p, n) => `${p.map(n).join(', ')} теперь администратор`,
	[WAMessageStubType.GROUP_PARTICIPANT_DEMOTE]: (p, n) => `${p.map(n).join(', ')} больше не администратор`,
	[WAMessageStubType.CALL_MISSED_VOICE]: () => '📞 Пропущенный аудиозвонок',
	[WAMessageStubType.CALL_MISSED_VIDEO]: () => '📹 Пропущенный видеозвонок',
	[WAMessageStubType.CALL_MISSED_GROUP_VOICE]: () => '📞 Пропущенный групповой звонок',
	[WAMessageStubType.CALL_MISSED_GROUP_VIDEO]: () => '📹 Пропущенный групповой видеозвонок',
	[WAMessageStubType.E2E_ENCRYPTED]: () => '🔒 Сообщения защищены сквозным шифрованием'
}

// Только содержимое (без контекста чата)
export function serializeContent(msg, nameOf = (j) => j?.split('@')[0]) {
	// «антиудаление»: содержимое удалённого сообщения сохранено локально
	if (msg._revoked) {
		const inner = msg.message ? serializeContent({ ...msg, _revoked: undefined, messageStubType: undefined }, nameOf) : null
		return inner ? { ...inner, deleted: true, kept: true } : { type: 'text', deleted: true }
	}
	if (msg.messageStubType === WAMessageStubType.REVOKE || (msg.message === null && msg.messageStubType)) {
		if (msg.messageStubType === WAMessageStubType.REVOKE) return { type: 'text', deleted: true }
	}
	if (!msg.message) {
		if (msg.messageStubType) {
			const f = STUB_TEXT[msg.messageStubType]
			const params = msg.messageStubParameters || []
			if (!f) return null
			return { type: 'system', text: f(params, nameOf) }
		}
		return null
	}
	const content = unwrap(msg.message)
	if (!content) return null
	const type = getContentType(content)
	if (!type || HIDDEN_TYPES.has(type)) return null
	const m = content[type]
	const out = { type: 'text' }
	const ctx = m?.contextInfo

	if (type === 'conversation') out.text = content.conversation
	else if (type === 'extendedTextMessage') {
		out.text = m.text
		if (m.backgroundArgb) out.bg = argb(m.backgroundArgb)
		if (m.textArgb) out.fg = argb(m.textArgb)
		if (m.matchedText || m.title) out.link = { url: m.matchedText || m.canonicalUrl, title: m.title, description: m.description, thumb: b64(m.jpegThumbnail) }
	} else if (MEDIA_TYPES[type]) {
		out.type = MEDIA_TYPES[type]
		out.text = m.caption || undefined
		out.media = {
			mimetype: m.mimetype,
			seconds: m.seconds || undefined,
			ptt: !!m.ptt || undefined,
			gif: !!m.gifPlayback || undefined,
			round: type === 'ptvMessage' || undefined,
			fileName: m.fileName || undefined,
			size: m.fileLength ? toNumber(m.fileLength) : undefined,
			width: m.width || undefined,
			height: m.height || undefined,
			pages: m.pageCount || undefined,
			animated: m.isAnimated || undefined,
			thumb: b64(m.jpegThumbnail),
			waveform: b64(m.waveform)
		}
	} else if (type === 'locationMessage' || type === 'liveLocationMessage') {
		out.type = 'location'
		out.location = { lat: m.degreesLatitude, lng: m.degreesLongitude, name: m.name, address: m.address, live: type === 'liveLocationMessage', thumb: b64(m.jpegThumbnail) }
		out.text = m.caption || undefined
	} else if (type === 'contactMessage') {
		out.type = 'contact'
		out.contact = { name: m.displayName, vcard: m.vcard }
	} else if (type === 'contactsArrayMessage') {
		out.type = 'contact'
		out.contact = { name: (m.contacts || []).map((c) => c.displayName).join(', '), vcard: m.contacts?.[0]?.vcard }
	} else if (type === 'pollCreationMessage' || type === 'pollCreationMessageV2' || type === 'pollCreationMessageV3' || type === 'pollCreationMessageV5') {
		out.type = 'poll'
		out.poll = { name: m.name, options: (m.options || []).map((o) => o.optionName), multi: (m.selectableOptionsCount || 0) !== 1 }
	} else if (type === 'eventMessage') {
		out.text = `📅 ${m.name || 'Событие'}${m.description ? '\n' + m.description : ''}`
	} else if (type === 'buttonsMessage' || type === 'templateMessage' || type === 'interactiveMessage' || type === 'listMessage') {
		out.text = m.contentText || m.text || m.description || m.body?.text || m.hydratedTemplate?.hydratedContentText || m.hydratedFourRowTemplate?.hydratedContentText || '[Интерактивное сообщение]'
	} else if (type === 'buttonsResponseMessage' || type === 'listResponseMessage' || type === 'templateButtonReplyMessage') {
		out.text = m.selectedDisplayText || m.title || m.selectedId || '[Ответ]'
	} else if (type === 'call' || type === 'bcallMessage' || type === 'callLogMesssage' || type === 'callLogMessage') {
		out.type = 'call'
		out.text = '📞 Звонок'
	} else if (type === 'groupInviteMessage') {
		out.text = `👥 Приглашение в группу «${m.groupName || ''}»`
	} else {
		out.text = `[${type}]`
	}

	// упоминания @123 -> @Имя
	if (out.text && ctx?.mentionedJid?.length) {
		for (const j of ctx.mentionedJid) {
			const user = j.split('@')[0]
			out.text = out.text.split('@' + user).join('@' + nameOf(j))
		}
	}
	if (ctx?.quotedMessage) {
		const q = { key: { id: ctx.stanzaId }, message: ctx.quotedMessage }
		const qd = serializeContent(q, nameOf)
		out.quoted = {
			id: ctx.stanzaId,
			sender: ctx.participant,
			senderName: ctx.participant ? nameOf(ctx.participant) : undefined,
			text: qd ? previewText(q) : '',
			thumb: qd?.media?.thumb
		}
	}
	if (ctx?.isForwarded) out.forwarded = true
	if (normalizeMessageContent(msg.message)?.editedMessage || msg.message?.editedMessage) out.edited = true
	if (m?.viewOnce || msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2) out.viewOnce = true
	return out
}
