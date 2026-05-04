const db = require('./db')
const { applyTemplate, formatPhone, sleep, sendWhatsapp, sendWhatsappMedia, personalizeWithAI } = require('./whatsapp')

const campaigns = new Map()
const recentOutboundMessages = new Map()
const OUTBOUND_IGNORE_MS = 10 * 60 * 1000

function normalizeOutboundText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function outboundKey(userId, phone) {
  return `${userId}:${String(phone || '').replace(/\D/g, '')}`
}

function rememberOutboundMessage(userId, phone, text) {
  const key = outboundKey(userId, phone)
  recentOutboundMessages.set(key, {
    text: normalizeOutboundText(text),
    at: Date.now()
  })
}

function isRecentOutboundMessage(userId, phone, text) {
  const key = outboundKey(userId, phone)
  const item = recentOutboundMessages.get(key)
  if (!item) return false
  if (Date.now() - item.at > OUTBOUND_IGNORE_MS) {
    recentOutboundMessages.delete(key)
    return false
  }
  return item.text === normalizeOutboundText(text)
}

function getCampaign(userId) {
  if (!campaigns.has(userId)) campaigns.set(userId, { running: false, stop: false, total: 0, sent: 0, failed: 0, log: [], results: [] })
  return campaigns.get(userId)
}

async function runCampaign(contacts, template, delayMin, delayMax, limit, useAI, media, templateId, templateName, userId, instanceName) {
  const c_ = getCampaign(userId)
  c_.running = true
  c_.stop = false
  c_.sent = 0
  c_.failed = 0
  c_.log = []
  c_.results = []
  const slice = contacts.filter(c => !c.optout).slice(0, limit)
  c_.total = slice.length
  const logId = Date.now().toString()
  // Write log entry upfront so webhook knows these phones belong to this campaign
  await db.addCampaignLog({
    id: logId,
    templateId: templateId || null,
    templateName: templateName || 'Sem nome',
    phones: slice.map(c => formatPhone(c.telefone)),
    contacts: slice.map(c => ({ nome: c.nome, telefone: c.telefone })),
    sent: 0, failed: 0,
    sentAt: new Date().toISOString()
  }, userId).catch(() => {})
  const sentPhones = []
  for (let i = 0; i < slice.length; i++) {
    if (c_.stop) { c_.log.push({ t: 'warn', m: 'Campanha interrompida pelo usuário.' }); break }
    const c = slice[i]
    c_.log.push({ t: 'info', m: `[${i+1}/${slice.length}] Enviando para ${c.nome}...` })
    try {
      const msg = useAI ? await personalizeWithAI(template, c) : applyTemplate(template, c)
      if (media) await sendWhatsappMedia(c.telefone, msg, media, instanceName)
      else await sendWhatsapp(c.telefone, msg, instanceName)
      rememberOutboundMessage(userId, formatPhone(c.telefone), msg)
      c_.sent++
      sentPhones.push(formatPhone(c.telefone))
      c_.results.push({ ...c, status: 'enviado', ts: new Date().toLocaleTimeString('pt-BR') })
      c_.log.push({ t: 'ok', m: `✔ ${c.nome} (${c.telefone})` })
    } catch (err) {
      c_.failed++
      c_.results.push({ ...c, status: 'falhou', erro: err.message, ts: new Date().toLocaleTimeString('pt-BR') })
      c_.log.push({ t: 'err', m: `✘ ${c.nome}: ${err.message}` })
    }
    if (i < slice.length - 1 && !c_.stop) {
      const d = Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin
      c_.log.push({ t: 'info', m: `⏳ Aguardando ${(d/1000).toFixed(1)}s...` })
      await sleep(d)
    }
  }
  c_.running = false
  c_.log.push({ t: 'ok', m: `Campanha finalizada. ${c_.sent} enviadas, ${c_.failed} falhas.` })
  // Update final counts on the log entry created at start
  await db.updateCampaignLogCounts(logId, c_.sent, c_.failed, userId).catch(() => {})
}

module.exports = { campaigns, getCampaign, runCampaign, rememberOutboundMessage, isRecentOutboundMessage }
