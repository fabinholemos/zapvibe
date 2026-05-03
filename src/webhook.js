const db = require('./db')
const { applyTemplate, formatPhone, sleep, fetchApi, sendWhatsapp, sendWhatsappMedia, detectMediatype, INSTANCE } = require('./whatsapp')

const replyTracker = new Map()
const REPLY_COOLDOWN = 5 * 60 * 1000
const processedMsgIds = new Set()

function isWithinSchedule(rule) {
  if (!rule.activeDays && !rule.activeStart && !rule.activeEnd) return true
  const now = new Date()
  const sp = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
  const day = sp.getDay()
  const mins = sp.getHours() * 60 + sp.getMinutes()
  if (rule.activeDays && rule.activeDays.length > 0 && !rule.activeDays.includes(day)) return false
  if (rule.activeStart && rule.activeEnd) {
    const [sh, sm] = rule.activeStart.split(':').map(Number)
    const [eh, em] = rule.activeEnd.split(':').map(Number)
    if (mins < sh * 60 + sm || mins >= eh * 60 + em) return false
  }
  return true
}

async function resolveJidForSending(jid, pushName, userId, instanceName) {
  if (!jid.endsWith('@lid')) return jid
  const lidKey = jid.replace(/@.+/, '')

  const cached = await db.getLidEntry(lidKey, userId)
  if (cached) { console.log('[LID] cache:', cached); return cached }

  if (pushName) {
    const words = pushName.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    const contacts = await db.getContacts(userId)
    const match = contacts.find(c =>
      words.length && words.every(w => (c.nome || '').toLowerCase().includes(w))
    )
    if (match) {
      const sendJid = formatPhone(match.telefone) + '@s.whatsapp.net'
      await db.saveLidEntry(lidKey, sendJid, userId)
      console.log('[LID] resolvido por nome CSV:', sendJid)
      return sendJid
    }
  }

  try {
    const evoContacts = await fetchApi(`/contact/findContacts/${instanceName}`, 'GET')
    if (Array.isArray(evoContacts)) {
      const firstName = (pushName || '').toLowerCase().split(' ')[0]
      const match = evoContacts.find(c =>
        firstName && (c.pushName || c.name || '').toLowerCase().startsWith(firstName) &&
        (c.id || '').includes('@s.whatsapp.net')
      )
      if (match?.id) {
        await db.saveLidEntry(lidKey, match.id, userId)
        console.log('[LID] resolvido por contatos Evolution:', match.id)
        return match.id
      }
    }
  } catch (e) { console.log('[LID] Evolution contacts lookup falhou:', e.message) }

  console.log('[LID] não resolvido, tentando @lid direto (pode falhar)')
  return jid
}

async function configureWebhookForInstance(instanceName) {
  const baseUrl = process.env.WEBHOOK_BASE_URL || `http://localhost:${process.env.PORT || 3000}`
  try {
    const result = await fetchApi(`/webhook/set/${instanceName}`, 'POST', {
      url: `${baseUrl}/webhook`,
      enabled: true,
      webhookByEvents: false,
      webhook_by_events: false,
      webhookBase64: false,
      webhook_base64: false,
      events: ['MESSAGES_UPSERT', 'GROUPS_UPSERT']
    })
    console.log(`✔ Webhook configurado para ${instanceName}:`, JSON.stringify(result).slice(0, 200))
  } catch (e) {
    console.log(`⚠ Webhook não configurado para ${instanceName}:`, e.message)
  }
}

async function configureWebhook() {
  const users = await db.getAllUsers().catch(() => [])
  for (const u of users) {
    if (u.status !== 'active' && u.role !== 'admin') continue
    const instances = await db.getUserInstances(u.id).catch(() => [])
    for (const inst of instances) {
      await configureWebhookForInstance(inst.instanceName).catch(() => {})
    }
  }
}

async function processWebhook(data) {
  const evt = (data.event || '').toLowerCase().replace(/\./g, '_')
  console.log('[Webhook] event:', data.event, '| normalizado:', evt)

  // Auto-capture groups when Baileys syncs them after connect
  if (evt === 'groups_upsert') {
    const instanceName = data.instance || INSTANCE
    const user = await db.getUserByInstance(instanceName).catch(() => null)
    if (!user) return
    const groups = (Array.isArray(data.data) ? data.data : [])
      .filter(g => (g.id || '').endsWith('@g.us'))
      .map(g => ({
        jid: g.id,
        name: g.subject || g.name || g.id,
        participants: g.size || (Array.isArray(g.participants) ? g.participants.length : 0)
      })).filter(g => g.jid)
    if (groups.length) {
      await db.syncWaGroups(user.id, instanceName, groups).catch(console.error)
      console.log(`[Webhook] GROUPS_UPSERT: ${groups.length} grupos salvos para ${instanceName}`)
    }
    return
  }

  if (!['messages_upsert', 'messages.upsert'].includes(evt)) return
  const msg = data.data
  if (!msg) return

  const jid = msg.key?.remoteJid || ''
  if (!jid) return

  // Dedup — Evolution API sometimes sends the same event twice
  const msgId = msg.key?.id
  if (msgId) {
    if (processedMsgIds.has(msgId)) { console.log('[Webhook] dup ignorado:', msgId); return }
    processedMsgIds.add(msgId)
    setTimeout(() => processedMsgIds.delete(msgId), 120000)
  }

  // captura grupo independente de fromMe (mensagem enviada por você também conta)
  if (jid.endsWith('@g.us')) {
    const instName = data.instance || INSTANCE
    const grpUser = await db.getUserByInstance(instName).catch(() => null)
    if (grpUser) {
      const grpName = data.data?.pushName || msg.key?.participant || jid
      await db.syncWaGroups(grpUser.id, instName, [{ jid, name: grpName, participants: 0 }]).catch(() => {})
      console.log(`[Webhook] grupo auto-capturado: ${jid} para ${instName}`)
    }
    return
  }

  // ignora fromMe só para auto-respostas (não para grupos)
  if (msg.key?.fromMe) return

  const instanceName = data.instance || INSTANCE
  const user = await db.getUserByInstance(instanceName).catch(() => null)
  if (!user) { console.log('[Webhook] instância sem usuário:', instanceName); return }
  const userId = user.id

  const pushName = msg.pushName || ''
  const sendTo = await resolveJidForSending(jid, pushName, userId, instanceName)
  const phone = sendTo.replace(/@.+/, '')

  const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').toLowerCase().trim()
  console.log('[Webhook] msg de', jid, '→ sendTo:', sendTo, '| texto:', text)

  // Opt-out detection — before cooldown check so it always works
  const OPTOUT_KEYWORDS = ['sair', 'parar', 'stop', 'cancelar', 'remover', 'descadastrar', 'nao quero', 'não quero']
  if (OPTOUT_KEYWORDS.some(kw => text === kw || text.startsWith(kw + ' ') || text.endsWith(' ' + kw))) {
    const allCts = await db.getContacts(userId)
    const optoutContact = allCts.find(c => {
      const n = c.telefone.replace(/\D/g, '')
      return phone.endsWith(n) || n.endsWith(phone) || ('55' + n) === phone || n === ('55' + phone)
    })
    if (optoutContact) {
      await db.setOptout(optoutContact.telefone, userId)
      await sendWhatsapp(sendTo, 'Você foi removido da nossa lista de mensagens e não receberá mais contato. ✓', instanceName).catch(() => {})
      console.log('[Opt-out]', phone, '| contato:', optoutContact.telefone)
    }
    return
  }

  const logs = await db.getCampaignLog(userId)
  const phoneLog = logs.slice().reverse().find(l => l.phones.includes(phone))
  const senderTemplateId = phoneLog?.templateId || null

  // Track response to campaign (once per contact per campaign)
  if (phoneLog) {
    db.trackCampaignResponse(phoneLog.id, phone, userId).catch(() => {})
  }

  const rules = (await db.getAutoreplies(userId)).filter(r => {
    if (!r.active) return false
    if (r.instanceName && r.instanceName !== instanceName) return false  // instance filter
    if (!r.templateId) return true                          // generic rule: always
    if (senderTemplateId === null) return false             // campaign rule: skip if sender unknown
    return r.templateId === senderTemplateId                // campaign rule: match only
  })
  let matched = null

  // Keywords rules checked first so menu + option flow works without cooldown blocking
  for (const rule of rules) {
    if (rule.trigger === 'keywords' && rule.keywords?.length) {
      const hit = rule.keywords.some(kw => {
        const k = kw.toLowerCase().trim()
        if (!k) return false
        // word-boundary match: exact, or surrounded by spaces
        return text === k || text.startsWith(k + ' ') || text.endsWith(' ' + k) || text.includes(' ' + k + ' ')
      })
      if (hit) { matched = rule; break }
    }
  }
  // "any" trigger only if no keyword rule matched — and apply cooldown to prevent loop
  if (!matched) {
    const lastReply = replyTracker.get(phone)
    if (lastReply && Date.now() - lastReply < REPLY_COOLDOWN) return
    for (const rule of rules) {
      if (rule.trigger === 'any') { matched = rule; break }
    }
  }

  console.log('[Webhook] regras ativas:', rules.length, '| matched:', matched?.name || 'nenhuma')
  if (!matched) return

  replyTracker.set(phone, Date.now())
  await sleep(matched.delay || 1500)

  const allContacts = await db.getContacts(userId)
  const contact = allContacts.find(c => {
    const n = c.telefone.replace(/\D/g, '')
    return phone.endsWith(n) || n.endsWith(phone) || ('55' + n) === phone || n === ('55' + phone)
  }) || { nome: msg.pushName || '', empresa: '', extra: '', telefone: phone }

  // Check schedule — send off-hours message if configured, otherwise skip
  if (!isWithinSchedule(matched)) {
    if (matched.offHoursMsg) {
      await sendWhatsapp(sendTo, applyTemplate(matched.offHoursMsg, contact), instanceName).catch(() => {})
      console.log(`[Auto-reply] fora do horário → ${sendTo} (regra: ${matched.name})`)
    }
    return
  }

  const replyText = applyTemplate(matched.response || '', contact)

  let replyResult
  if (matched.mediaBase64 && matched.mediaMimetype) {
    replyResult = await sendWhatsappMedia(sendTo, replyText, {
      base64: matched.mediaBase64,
      mimetype: matched.mediaMimetype,
      filename: matched.mediaFilename || 'arquivo',
      mediatype: detectMediatype(matched.mediaMimetype)
    }, instanceName).catch(e => ({ error: e.message }))
  } else {
    replyResult = await sendWhatsapp(sendTo, replyText, instanceName).catch(e => ({ error: e.message }))
  }

  console.log(`[Auto-reply] → ${sendTo} (regra: ${matched.name}) | API:`, JSON.stringify(replyResult))

  // Follow-up steps — queue hour-based follow-up messages for this contact
  if (matched.followupSteps?.length) {
    const existing = await db.getPendingFollowups(userId).catch(() => [])
    const alreadyEnrolled = existing.some(item => item.phone === phone && item.rule_id === matched.id)
    if (!alreadyEnrolled) {
      let cumMs = 0
      const items = matched.followupSteps.map((s, i) => {
        cumMs += (s.delayHours || 1) * 3600000
        return {
          id: `fup_${Date.now()}_${phone}_${i}_${matched.id}`,
          userId, ruleId: matched.id,
          phone, nome: contact.nome || '',
          instanceName,
          stepIndex: i,
          message: applyTemplate(s.message || '', contact),
          sendAt: new Date(Date.now() + cumMs).toISOString()
        }
      })
      await db.addFollowupItems(items).catch(() => {})
      console.log(`[Auto-reply] followup enrolled: ${phone} → ${matched.name} (${items.length} etapas)`)
    }
  }
}

module.exports = { processWebhook, configureWebhook, configureWebhookForInstance }
