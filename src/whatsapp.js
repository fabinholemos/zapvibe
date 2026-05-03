const db = require('./db')

const API_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080'
const API_KEY = process.env.EVOLUTION_API_KEY || ''
const INSTANCE = process.env.INSTANCE_NAME || 'minha-empresa'

function applyTemplate(tpl, c) {
  return tpl
    .replace(/\{nome\}/gi, c.nome || '')
    .replace(/\{empresa\}/gi, c.empresa || '')
    .replace(/\{extra\}/gi, c.extra || '')
    .replace(/\{telefone\}/gi, c.telefone || '')
    .replace(/\{vencimento\}/gi, c.vencimento || '')
}

function formatPhone(phone) {
  if (phone.includes('@')) return phone
  let n = phone.replace(/\D/g, '')
  if (!n.startsWith('55')) n = '55' + n
  return n
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function fetchApi(urlPath, method, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(API_URL + urlPath)
    const isHttps = u.protocol === 'https:'
    const transport = isHttps ? require('https') : require('http')
    const opts = {
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method,
      headers: { apikey: API_KEY, 'Content-Type': 'application/json' }
    }
    const req = transport.request(opts, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({}) } })
    })
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Evolution API timeout')) })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function sendWhatsapp(phone, text, instanceName) {
  return fetchApi(`/message/sendText/${instanceName}`, 'POST', { number: formatPhone(phone), textMessage: { text } })
}

async function sendWhatsappMedia(phone, caption, media, instanceName) {
  const number = formatPhone(phone)
  if (media.mediatype === 'audio') {
    return fetchApi(`/message/sendWhatsAppAudio/${instanceName}`, 'POST', {
      number, audioMessage: { audio: media.base64 }
    })
  }
  return fetchApi(`/message/sendMedia/${instanceName}`, 'POST', {
    number,
    mediaMessage: {
      mediatype: media.mediatype,
      mimetype: media.mimetype,
      caption,
      media: media.base64,
      fileName: media.filename
    }
  })
}

async function notifyAdminNewUser(name, email, phone) {
  const adminPhone = process.env.ADMIN_PHONE
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase()
  if (!adminPhone || !adminEmail) return
  const admin = await db.getUserByEmail(adminEmail)
  if (!admin?.instance_name) return
  const when = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  const msg = `🆕 *Novo cadastro no ZapVibe!*\n\n👤 *Nome:* ${name}\n📧 *E-mail:* ${email}\n📱 *Telefone:* ${phone}\n⏰ *Horário:* ${when}\n\nAcesse o painel admin para ativar.`
  await sendWhatsapp(adminPhone, msg, admin.instance_name)
}

function detectMediatype(mimetype) {
  if (mimetype.startsWith('image/')) return 'image'
  if (mimetype.startsWith('video/')) return 'video'
  if (mimetype.startsWith('audio/')) return 'audio'
  return 'document'
}

async function personalizeWithAI(template, contact) {
  if (process.env.USE_AI !== 'true' || !process.env.GROQ_API_KEY || process.env.GROQ_API_KEY.includes('sua_')) {
    return applyTemplate(template, contact)
  }
  try {
    const Groq = require('groq-sdk')
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: `Reescreva de forma natural e personalizada para WhatsApp. Regras OBRIGATÓRIAS:\n- Preserve EXATAMENTE a formatação WhatsApp: *negrito*, _itálico_, quebras de linha\n- Não remova nem altere os asteriscos (*) ou underscores (_) de formatação\n- Mantenha o conteúdo e estrutura da mensagem\n- Sem inventar informações\n\nContato: nome=${contact.nome}, empresa=${contact.empresa||''}, extra=${contact.extra||''}\n\nMensagem original:\n${applyTemplate(template, contact)}\n\nRetorne APENAS a mensagem reescrita, preservando toda formatação.` }],
      max_tokens: 600, temperature: 0.7
    })
    return completion.choices[0]?.message?.content?.trim() || applyTemplate(template, contact)
  } catch { return applyTemplate(template, contact) }
}

module.exports = {
  applyTemplate, formatPhone, sleep, fetchApi,
  sendWhatsapp, sendWhatsappMedia, notifyAdminNewUser, detectMediatype, personalizeWithAI,
  API_URL, API_KEY, INSTANCE
}
