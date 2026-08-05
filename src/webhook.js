const db = require('./db')
const { applyTemplate, formatPhone, sleep, fetchApi, sendWhatsapp, sendWhatsappMedia, detectMediatype, downloadMedia, INSTANCE } = require('./whatsapp')
const { rememberOutboundMessage, isRecentOutboundMessage } = require('./campaign')

const replyTracker = new Map()
const REPLY_COOLDOWN = 5 * 60 * 1000
const processedMsgIds = new Set()

function extractMessageText(msg) {
  return msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    ''
}

function describeMessage(msg) {
  const types = Object.keys(msg.message || {}).join(',') || 'sem message'
  const text = extractMessageText(msg).replace(/\s+/g, ' ').trim().slice(0, 80)
  return `id=${msg.key?.id || '-'} jid=${msg.key?.remoteJid || '-'} fromMe=${!!msg.key?.fromMe} types=${types} text="${text}"`
}
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
      if (inst.enabled === false) continue
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

  if (!['messages_upsert', 'messages.upsert'].includes(evt)) { console.log('[Webhook] ignorado: evento sem mensagens', evt); return }
  const msg = Array.isArray(data.data) ? data.data[0] : data.data
  if (!msg) { console.log('[Webhook] ignorado: payload sem data', Object.keys(data || {})); return }

  const instanceName = data.instance || INSTANCE
  const jid = msg.key?.remoteJid || ''
  if (!jid) { console.log('[Webhook] ignorado: mensagem sem remoteJid |', describeMessage(msg)); return }

  // Dedup — Evolution API sometimes sends the same event twice (with different or same IDs)
  const msgId = msg.key?.id
  const msgDedupeKey = msgId ? instanceName + ':' + msgId : null
  if (msgDedupeKey) {
    if (processedMsgIds.has(msgDedupeKey)) { console.log('[Webhook] dup ignorado (id):', msgDedupeKey); return }
    processedMsgIds.add(msgDedupeKey)
    setTimeout(() => processedMsgIds.delete(msgDedupeKey), 120000)
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
  if (msg.key?.fromMe) { console.log('[Webhook] ignorado: fromMe |', describeMessage(msg)); return }

  const user = await db.getUserByInstance(instanceName).catch(() => null)
  if (!user) { console.log('[Webhook] instância sem usuário:', instanceName); return }
  const userId = user.id

  const pushName = msg.pushName || ''
  const sendTo = await resolveJidForSending(jid, pushName, userId, instanceName)
  const phone = sendTo.replace(/@.+/, '')

  const text = extractMessageText(msg).toLowerCase().trim()
  console.log('[Webhook] msg de', jid, '→ sendTo:', sendTo, '| texto:', text)

  if (isRecentOutboundMessage(userId, phone, text)) {
    console.log('[Webhook] ignorado: eco de mensagem enviada recentemente para', phone)
    return
  }

  // Comprovante de pagamento — imagem ou PDF recebido de um contato conhecido vira "pagamento pendente"
  const comprovanteMedia = msg.message?.imageMessage
    ? { key: 'imageMessage', mimetype: msg.message.imageMessage.mimetype || 'image/jpeg' }
    : (msg.message?.documentMessage?.mimetype === 'application/pdf'
        ? { key: 'documentMessage', mimetype: 'application/pdf' }
        : null)
  if (comprovanteMedia) {
    const allCtsImg = await db.getContacts(userId).catch(() => [])
    const payContact = allCtsImg.find(c => {
      const n = c.telefone.replace(/\D/g, '')
      return phone.endsWith(n) || n.endsWith(phone) || ('55' + n) === phone || n === ('55' + phone)
    })
    if (payContact && payContact.optout) {
      // contato conhecido mas pediu pra sair — não processa
    } else {
      try {
        const media = await downloadMedia(instanceName, msg.key.id)
        if (media?.base64) {
          await db.addPendingPayment({
            id: `pay_${Date.now()}_${phone}`,
            telefone: payContact ? payContact.telefone : '',
            nome: payContact ? payContact.nome : (pushName || 'Não identificado'),
            imageBase64: media.base64,
            mimetype: media.mimetype || comprovanteMedia.mimetype,
            instanceName,
            jid: sendTo
          }, userId)
          const confirmText = 'Recebemos seu comprovante! Vamos confirmar e já atualizamos sua renovação. ✓'
          rememberOutboundMessage(userId, phone, confirmText)
          await sendWhatsapp(sendTo, confirmText, instanceName).catch(() => {})
          if (payContact) {
            console.log('[Pagamento] comprovante recebido de', phone, '(', payContact.nome, ') tipo:', comprovanteMedia.key)
          } else {
            console.log('[Pagamento] comprovante de remetente NÃO IDENTIFICADO (telefone não bateu, provavelmente @lid) — foi pra fila pra vínculo manual. jid:', jid, '| pushName:', pushName)
          }
        } else {
          console.log('[Pagamento] mídia sem base64 para', phone)
        }
      } catch (e) {
        console.log('[Pagamento] erro ao baixar mídia:', e.message)
      }
      return
    }
  }

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

  const allRules = await db.getAutoreplies(userId)
  console.log('[Rule debug] total regras no DB:', allRules.length, '| instanceName webhook:', instanceName, '| senderTemplateId:', senderTemplateId)
  const rules = allRules.filter(r => {
    if (!r.active) { console.log('[Rule debug]', r.name, '→ BLOQUEADO: inativa'); return false }

    // Campaign-linked rules should follow the campaign/template first. This avoids
    // blocking replies when the same user's connected WhatsApp instance differs from
    // the friendly label selected in the rule UI.
    if (r.templateId) {
      if (senderTemplateId === null) { console.log('[Rule debug]', r.name, '→ BLOQUEADO: templateId', r.templateId, 'mas sender sem campanha'); return false }
      const ok = r.templateId === senderTemplateId
      if (ok) console.log('[Rule debug]', r.name, '→ PASS (campanha associada)', r.templateId)
      else console.log('[Rule debug]', r.name, '→ BLOQUEADO: templateId', r.templateId, '≠', senderTemplateId)
      return ok
    }

    if (r.instanceName && r.instanceName !== instanceName) { console.log('[Rule debug]', r.name, '→ BLOQUEADO: instanceName', r.instanceName, '≠', instanceName); return false }
    if (r.trigger === 'any') {
      const ok = senderTemplateId === null
      console.log('[Rule debug]', r.name, '→', ok ? 'PASS' : 'BLOQUEADO: any só orgânico mas sender tem campanha', senderTemplateId)
      return ok
    }
    console.log('[Rule debug]', r.name, '→ PASS (keyword global)')
    return true
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
    console.log(`[Auto-reply] fora do horário → ${sendTo} (regra: ${matched.name})`)
    if (matched.offHoursMsg) {
      const offHoursText = applyTemplate(matched.offHoursMsg, contact)
      rememberOutboundMessage(userId, phone, offHoursText)
      await sendWhatsapp(sendTo, offHoursText, instanceName).catch(() => {})
    }
    return
  }

  const replyText = applyTemplate(matched.response || '', contact)
  rememberOutboundMessage(userId, phone, replyText)

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
