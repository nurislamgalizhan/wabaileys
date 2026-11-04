// Автоответчик (правила + ответы через Claude) и вебхуки
import crypto from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'

// модели, для которых доступен серверный fallback при отказе (refusal)
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'])

const BASE_PROMPT = `Ты отвечаешь в WhatsApp от имени владельца аккаунта.
Пиши коротко и естественно, как человек в мессенджере: 1–3 предложения, без markdown, без списков.
Отвечай на языке собеседника. Если не знаешь ответа или вопрос требует решения владельца — вежливо скажи, что он ответит позже.
Не придумывай факты о владельце, встречах, ценах и договорённостях.`

function matches(rule, text) {
	const t = String(text || '').trim().toLowerCase()
	const pattern = String(rule.pattern || '').trim()
	switch (rule.match) {
		case 'any':
			return true
		case 'exact':
			return pattern.split('|').some((p) => p.trim().toLowerCase() === t)
		case 'regex':
			try {
				return new RegExp(pattern, 'i').test(text || '')
			} catch {
				return false
			}
		default: // contains: несколько слов через запятую — любое из них
			return pattern
				.split(',')
				.map((p) => p.trim().toLowerCase())
				.filter(Boolean)
				.some((p) => t.includes(p))
	}
}

export function attachBot(wa, { accountId }) {
	const cooldown = new Map()
	const log = (entry) => {
		const item = { ...entry, at: Date.now() }
		wa.botLog = [item, ...(wa.botLog || [])].slice(0, 50)
		wa.emit('bot.log', item)
	}

	wa.on('incoming', async ({ dto, msg }) => {
		// ---- вебхук: все новые сообщения (входящие и отправленные с телефона)
		if (wa.settings.webhookUrl) sendWebhook(wa, accountId, dto).catch((err) => wa.logger.warn({ err: err.message }, 'webhook failed'))

		// ---- автоответчик
		if (!wa.settings.botEnabled || dto.fromMe || dto.type === 'system') return
		const isGroup = dto.chatId.endsWith('@g.us')
		for (const rule of wa.store.rules()) {
			if (!rule.enabled) continue
			if (rule.scope === 'private' && isGroup) continue
			if (rule.scope === 'groups' && !isGroup) continue
			if (rule.onlyAway && wa.anyVisible()) continue // только когда вкладка закрыта
			if (!matches(rule, dto.text)) continue
			const key = rule.id + '|' + dto.chatId
			const cd = (Number(rule.cooldownMin) || 0) * 60_000
			if (cd && Date.now() - (cooldown.get(key) || 0) < cd) return // правило сработало недавно
			cooldown.set(key, Date.now())
			try {
				const text = rule.ai ? await aiReply(wa, rule, dto.chatId) : rule.reply
				if (!text) return
				if (rule.delaySec) await new Promise((r) => setTimeout(r, Math.min(rule.delaySec, 120) * 1000))
				await wa.requireSock().sendMessage(dto.chatId, { text }, rule.quote ? { quoted: msg } : undefined)
				log({ rule: rule.name || '#' + rule.id, chat: wa.nameOf(dto.chatId), text })
			} catch (err) {
				log({ rule: rule.name || '#' + rule.id, chat: wa.nameOf(dto.chatId), error: err.message })
			}
			return // срабатывает только первое подходящее правило
		}
	})
}

// ответ через Claude с учётом последних сообщений чата
async function aiReply(wa, rule, chatId) {
	const apiKey = wa.store.get('secret.aiKey') || process.env.ANTHROPIC_API_KEY
	if (!apiKey) throw new Error('Не задан ключ Claude API (настройки бота или ANTHROPIC_API_KEY)')
	const client = new Anthropic({ apiKey })
	const model = wa.settings.aiModel || 'claude-opus-5-5'
	const isGroup = chatId.endsWith('@g.us')

	const history = wa.store
		.pageMessages(chatId, Number.MAX_SAFE_INTEGER, 30)
		.map((m) => wa.messageDTO(chatId, m))
		.filter(Boolean)
	const messages = []
	for (const m of history) {
		const role = m.fromMe ? 'assistant' : 'user'
		let text = m.deleted && !m.kept ? '' : m.text || describe(m)
		if (!text) continue
		if (isGroup && !m.fromMe) text = `${m.senderName || 'Участник'}: ${text}`
		const prev = messages[messages.length - 1]
		if (prev?.role === role) prev.content += '\n' + text
		else messages.push({ role, content: text })
	}
	while (messages[0]?.role === 'assistant') messages.shift() // диалог должен начинаться с пользователя
	if (!messages.length || messages[messages.length - 1].role !== 'user') return null

	const params = {
		model,
		max_tokens: 4000,
		system: [BASE_PROMPT, rule.aiPrompt].filter(Boolean).join('\n\n'),
		output_config: { effort: 'low' }, // короткие ответы в чате — низкого усилия достаточно
		messages
	}
	if (FALLBACK_MODELS.has(model)) {
		params.betas = ['server-side-fallback-2026-07-01']
		params.fallbacks = 'default'
	}
	let response
	try {
		response = await client.beta.messages.create(params)
	} catch (err) {
		if (err instanceof Anthropic.AuthenticationError) throw new Error('Неверный ключ Claude API')
		if (err instanceof Anthropic.RateLimitError) throw new Error('Превышен лимит запросов Claude API')
		if (err instanceof Anthropic.APIError) throw new Error(`Claude API ${err.status}: ${err.message}`)
		throw err
	}
	if (response.stop_reason === 'refusal') return null
	const text = response.content
		.filter((b) => b.type === 'text')
		.map((b) => b.text)
		.join('')
		.trim()
	return text || null
}

function describe(m) {
	const map = { image: '[фото]', video: '[видео]', audio: m.media?.ptt ? '[голосовое сообщение]' : '[аудио]', document: '[документ]', sticker: '[стикер]', location: '[геолокация]', contact: '[контакт]', poll: '[опрос]' }
	return map[m.type] || ''
}

async function sendWebhook(wa, accountId, dto) {
	const body = JSON.stringify({ event: 'message', account: accountId, message: dto })
	const headers = { 'Content-Type': 'application/json' }
	const secret = wa.webhookSecret?.()
	if (secret) headers['X-Signature'] = crypto.createHmac('sha256', secret).update(body).digest('hex')
	const r = await fetch(wa.settings.webhookUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) })
	if (!r.ok) throw new Error('HTTP ' + r.status)
}

export { matches }
