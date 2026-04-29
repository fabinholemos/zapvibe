require('dotenv').config()
const http = require('http')
const { exec } = require('child_process')
const { parse } = require('csv-parse/sync')
const crypto = require('crypto')
const db = require('./db')

// ── Auth helpers ──────────────────────────────────────────────────────────────

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex')
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err)
      else resolve(`${salt}:${key.toString('hex')}`)
    })
  })
}

function verifyPassword(password, hash) {
  return new Promise((resolve, reject) => {
    const [salt, key] = hash.split(':')
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err)
      else resolve(derived.toString('hex') === key)
    })
  })
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex')
}

function parseCookies(req) {
  const header = req.headers.cookie || ''
  return Object.fromEntries(header.split(';').map(c => c.trim().split('=').map(decodeURIComponent)))
}

async function getAuthSession(req) {
  const cookies = parseCookies(req)
  if (!cookies.session) return null
  return db.getSession(cookies.session)
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZapVibe — Login</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
*{font-family:'Inter',sans-serif}
</style>
</head>
<body class="bg-gray-950 text-white min-h-screen flex items-center justify-center">
<div class="w-full max-w-sm px-4">
  <div class="mb-6"><a href="/" class="inline-flex items-center gap-2 text-sm font-medium text-violet-400 hover:text-violet-300 transition-colors">← Voltar ao início</a></div>
  <div class="flex flex-col items-center mb-8">
    <div class="w-12 h-12 rounded-2xl bg-violet-600 flex items-center justify-center text-2xl mb-3">⚡</div>
    <h1 class="text-xl font-bold">ZapVibe</h1>
    <p class="text-sm text-gray-500 mt-1">Disparador inteligente de WhatsApp</p>
  </div>
  <div class="bg-gray-900 border border-gray-800 rounded-2xl p-6">
    <h2 class="text-base font-semibold mb-5">Entrar</h2>
    <div id="err" class="hidden bg-red-950 border border-red-800 text-red-300 text-sm px-4 py-2.5 rounded-xl mb-4"></div>
    <form id="form" class="space-y-4">
      <div>
        <label class="block text-xs text-gray-400 mb-1.5">E-mail</label>
        <input id="email" type="email" required autocomplete="email"
          class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500 transition-colors"
          placeholder="seu@email.com">
      </div>
      <div>
        <label class="block text-xs text-gray-400 mb-1.5">Senha</label>
        <input id="pass" type="password" required autocomplete="current-password"
          class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500 transition-colors"
          placeholder="••••••••">
      </div>
      <button type="submit"
        class="w-full bg-violet-600 hover:bg-violet-500 text-white font-medium py-2.5 rounded-xl transition-colors text-sm">
        Entrar
      </button>
    </form>
  </div>
</div>
<script>
document.getElementById('form').onsubmit = async e => {
  e.preventDefault()
  const btn = e.target.querySelector('button')
  btn.disabled = true; btn.textContent = 'Entrando...'
  const err = document.getElementById('err')
  err.classList.add('hidden')
  const res = await fetch('/login', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('pass').value })
  })
  if (res.ok) { const p = new URLSearchParams(location.search); window.location.href = p.get('next') || '/app' }
  else {
    const d = await res.json()
    err.textContent = d.error || 'Erro ao entrar'
    err.classList.remove('hidden')
    btn.disabled = false; btn.textContent = 'Entrar'
  }
}
</script>
</body>
</html>`

const PORT = process.env.PORT || 3000
const API_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080'
const API_KEY = process.env.EVOLUTION_API_KEY || ''
const INSTANCE = process.env.INSTANCE_NAME || 'minha-empresa'

const DEFAULT_TEMPLATE = `Ola, {nome}! Tudo bem?

Estou entrando em contato para apresentar o ZapVibe, nossa solucao de comunicacao via WhatsApp com inteligencia artificial.

Posso te mostrar como funciona em poucos minutos?`

const campaigns = new Map() // userId → campaign state
const mediaStore = new Map() // userId → currentMedia
const replyTracker = new Map() // phone → timestamp (anti-loop)
const REPLY_COOLDOWN = 5 * 60 * 1000

function getCampaign(userId) {
  if (!campaigns.has(userId)) campaigns.set(userId, { running: false, stop: false, total: 0, sent: 0, failed: 0, log: [], results: [] })
  return campaigns.get(userId)
}

// ── helpers ──────────────────────────────────────────────────────────────────

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
  const baseUrl = process.env.WEBHOOK_BASE_URL || `http://host.docker.internal:${PORT}`
  try {
    await fetchApi(`/webhook/set/${instanceName}`, 'POST', {
      url: `${baseUrl}/webhook`,
      webhookByEvents: false,
      events: ['MESSAGES_UPSERT']
    })
    console.log(`✔ Webhook configurado para ${instanceName}`)
  } catch (e) {
    console.log(`⚠ Webhook não configurado para ${instanceName}`)
  }
}

async function configureWebhook() {
  const users = await db.getAllUsers().catch(() => [])
  for (const u of users) {
    if (u.instance_name && u.status === 'active') {
      await configureWebhookForInstance(u.instance_name).catch(() => {})
    }
  }
}

async function processWebhook(data) {
  const evt = (data.event || '').toLowerCase().replace('.', '_')
  console.log('[Webhook] event:', data.event, '| normalizado:', evt)
  if (!['messages_upsert', 'messages.upsert'].includes(evt)) return
  const msg = data.data
  if (!msg || msg.key?.fromMe) { console.log('[Webhook] ignorado: fromMe ou sem msg'); return }

  const jid = msg.key?.remoteJid || ''
  if (!jid || jid.endsWith('@g.us')) { console.log('[Webhook] ignorado: grupo ou sem jid'); return }

  const instanceName = data.instance || INSTANCE
  const user = await db.getUserByInstance(instanceName).catch(() => null)
  if (!user) { console.log('[Webhook] instância sem usuário:', instanceName); return }
  const userId = user.id

  const pushName = msg.pushName || ''
  const sendTo = await resolveJidForSending(jid, pushName, userId, instanceName)
  const phone = sendTo.replace(/@.+/, '')

  const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').toLowerCase().trim()
  console.log('[Webhook] msg de', jid, '→ sendTo:', sendTo, '| texto:', text)

  const lastReply = replyTracker.get(phone)
  if (lastReply && Date.now() - lastReply < REPLY_COOLDOWN) return

  const logs = await db.getCampaignLog(userId)
  const phoneLog = logs.slice().reverse().find(l => l.phones.includes(phone))
  const senderTemplateId = phoneLog?.templateId || null

  const rules = (await db.getAutoreplies(userId)).filter(r => {
    if (!r.active) return false
    if (!r.templateId) return true
    if (senderTemplateId === null) return true
    return r.templateId === senderTemplateId
  })
  let matched = null

  for (const rule of rules) {
    if (rule.trigger === 'any') { matched = rule; break }
    if (rule.trigger === 'keywords' && rule.keywords?.length) {
      const hit = rule.keywords.some(kw => text.includes(kw.toLowerCase().trim()))
      if (hit) { matched = rule; break }
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
}

function applyTemplate(tpl, c) {
  return tpl
    .replace(/\{nome\}/gi, c.nome || '')
    .replace(/\{empresa\}/gi, c.empresa || '')
    .replace(/\{extra\}/gi, c.extra || '')
    .replace(/\{telefone\}/gi, c.telefone || '')
    .replace(/\{vencimento\}/gi, c.vencimento || '')
}

function formatPhone(phone) {
  if (phone.includes('@')) return phone // already a full JID (@s.whatsapp.net or @lid)
  let n = phone.replace(/\D/g, '')
  if (!n.startsWith('55')) n = '55' + n
  return n
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function fetchApi(urlPath, method, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(API_URL + urlPath)
    const isHttps = u.protocol === 'https:'
    const transport = isHttps ? require('https') : require('http')
    const opts = {
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname, method,
      headers: { apikey: API_KEY, 'Content-Type': 'application/json' }
    }
    const req = transport.request(opts, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({}) } })
    })
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

async function runCampaign(contacts, template, delayMin, delayMax, limit, useAI, media, templateId, templateName, userId, instanceName) {
  const c_ = getCampaign(userId)
  c_.running = true
  c_.stop = false
  c_.total = Math.min(contacts.length, limit)
  c_.sent = 0
  c_.failed = 0
  c_.log = []
  c_.results = []
  const slice = contacts.slice(0, limit)
  const sentPhones = []
  for (let i = 0; i < slice.length; i++) {
    if (c_.stop) { c_.log.push({ t: 'warn', m: 'Campanha interrompida pelo usuário.' }); break }
    const c = slice[i]
    c_.log.push({ t: 'info', m: `[${i+1}/${slice.length}] Enviando para ${c.nome}...` })
    try {
      const msg = useAI ? await personalizeWithAI(template, c) : applyTemplate(template, c)
      if (media) await sendWhatsappMedia(c.telefone, msg, media, instanceName)
      else await sendWhatsapp(c.telefone, msg, instanceName)
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
  if (sentPhones.length) {
    const sentContacts = c_.results.filter(r => r.status === 'enviado').map(r => ({ nome: r.nome, telefone: r.telefone }))
    await db.addCampaignLog({
      id: Date.now().toString(),
      templateId: templateId || null,
      templateName: templateName || 'Sem nome',
      phones: sentPhones,
      contacts: sentContacts,
      sent: c_.sent,
      failed: c_.failed,
      sentAt: new Date().toISOString()
    }, userId)
  }
}

// ── body parser ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve({}) } })
    req.on('error', reject)
  })
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function getAppHTML(email, isAdmin, userInstance) { return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZapVibe</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
*{font-family:'Inter',sans-serif}
.tab-active{background:rgb(124 58 237);color:#fff}
.tab{transition:all .15s}
.pulse-g{animation:pg 2s infinite}
@keyframes pg{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.4)}50%{box-shadow:0 0 0 8px rgba(34,197,94,0)}}
.fade{animation:fd .3s ease}
@keyframes fd{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
textarea{resize:vertical}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:#111}::-webkit-scrollbar-thumb{background:#333;border-radius:3px}
</style>
</head>
<body class="bg-gray-950 text-white min-h-screen">

<div class="max-w-4xl mx-auto px-4 py-8">

  <!-- Header -->
  <div class="flex items-center gap-3 mb-6">
    <div class="w-9 h-9 rounded-xl bg-violet-600 flex items-center justify-center text-lg">⚡</div>
    <div><h1 class="text-lg font-bold">ZapVibe</h1><p class="text-xs text-gray-500">Disparador inteligente de WhatsApp</p></div>
    <div class="ml-auto flex items-center gap-3">
      <span id="hd-dot" class="w-2 h-2 rounded-full bg-gray-600"></span>
      <span id="hd-txt" class="text-xs text-gray-400">—</span>
      <span class="text-xs text-gray-500 hidden sm:block">${email}</span>
      ${isAdmin ? `<a href="/admin" class="text-xs px-2.5 py-1 bg-violet-900/50 hover:bg-violet-800/60 border border-violet-700/50 text-violet-300 rounded-lg transition-colors">Admin</a>` : ''}
      <form method="POST" action="/logout"><button class="text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors">Sair</button></form>
    </div>
  </div>

  <!-- Tabs -->
  <div class="flex gap-1 bg-gray-900 p-1 rounded-xl mb-6 border border-gray-800">
    <button onclick="tab('conn')" id="t-conn" class="tab tab-active flex-1 py-2 text-sm font-medium rounded-lg">📱 Conexão</button>
    <button onclick="tab('contacts')" id="t-contacts" class="tab flex-1 py-2 text-sm font-medium rounded-lg text-gray-400 hover:text-white">👥 Contatos</button>
    <button onclick="tab('campaign')" id="t-campaign" class="tab flex-1 py-2 text-sm font-medium rounded-lg text-gray-400 hover:text-white">📤 Campanha</button>
    <button onclick="tab('auto')" id="t-auto" class="tab flex-1 py-2 text-sm font-medium rounded-lg text-gray-400 hover:text-white">🤖 Auto-respostas</button>
    <button onclick="tab('hist')" id="t-hist" class="tab flex-1 py-2 text-sm font-medium rounded-lg text-gray-400 hover:text-white">📊 Histórico</button>
  </div>

  <!-- ── TAB: Histórico ── -->
  <div id="p-hist" class="hidden fade space-y-4">
    <div class="flex items-center justify-between">
      <div>
        <p class="text-sm text-gray-400">Histórico de campanhas enviadas e controle anti-spam.</p>
      </div>
      <button onclick="loadHistory()" class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors">↻ Atualizar</button>
    </div>

    <!-- Anti-spam summary -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-4">
      <p class="text-xs text-gray-500 uppercase tracking-wider mb-3">Última mensagem por contato</p>
      <div id="antispam-list" class="space-y-1.5">
        <p class="text-xs text-gray-600 text-center py-4">Nenhuma campanha enviada ainda.</p>
      </div>
    </div>

    <!-- Campaign history -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div class="px-4 py-3 border-b border-gray-800">
        <span class="text-xs text-gray-500 uppercase tracking-wider">Campanhas enviadas</span>
      </div>
      <div id="hist-list" class="divide-y divide-gray-800">
        <p class="text-xs text-gray-600 text-center py-8">Nenhuma campanha enviada ainda.</p>
      </div>
    </div>
  </div>

  <!-- ── TAB: Auto-respostas ── -->
  <div id="p-auto" class="hidden fade">

    <div class="flex items-center justify-between mb-4">
      <div>
        <p class="text-sm text-gray-400">Responde automaticamente quando alguém te manda mensagem.</p>
        <p id="webhook-status" class="text-xs text-gray-600 mt-0.5">Verificando webhook...</p>
      </div>
      <button onclick="openAutoModal()" class="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl">+ Nova regra</button>
    </div>

    <!-- Ordem importa -->
    <div class="bg-amber-950/40 border border-amber-800/50 rounded-xl px-4 py-3 mb-4 text-xs text-amber-300">
      ⚡ <strong>Ordem importa:</strong> primeira regra que bater é executada. Regras com palavras-chave devem vir antes do "qualquer mensagem".
    </div>

    <div id="auto-list" class="space-y-3">
      <div class="text-center py-12 text-gray-600">
        <p class="text-4xl mb-2">🤖</p>
        <p>Nenhuma regra criada ainda.</p>
      </div>
    </div>
  </div>

  <!-- ── TAB: Conexão ── -->
  <div id="p-conn" class="fade">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div class="bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <p class="text-xs text-gray-500 uppercase tracking-wider mb-3">Status da instância</p>
        <div class="flex items-center gap-3 mb-4">
          <span id="c-dot" class="w-3 h-3 rounded-full bg-gray-600"></span>
          <span id="c-state" class="text-lg font-semibold text-gray-300">Verificando...</span>
        </div>
        <p class="text-xs text-gray-500 mb-1">Instância</p>
        <p class="text-sm font-mono text-violet-400 mb-4">${userInstance}</p>
        <div class="flex gap-2">
          <button onclick="doConnect()" class="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl transition-colors">Conectar</button>
          <button onclick="doDisconnect()" class="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors">Desconectar</button>
        </div>
      </div>
      <div class="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex flex-col items-center justify-center min-h-48">
        <div id="qr-wrap" class="hidden flex-col items-center gap-3">
          <div class="bg-white p-3 rounded-xl"><img id="qr-img" src="" class="w-48 h-48 object-contain"/></div>
          <p class="text-xs text-gray-400">Escaneie com o WhatsApp</p>
          <p class="text-xs text-gray-600 text-center">Celular → 3 pontos → Aparelhos conectados → Conectar</p>
        </div>
        <div id="qr-connected" class="hidden flex-col items-center gap-2">
          <div class="w-16 h-16 rounded-full bg-green-900 border-2 border-green-500 flex items-center justify-center text-3xl pulse-g">✓</div>
          <p class="text-green-400 font-semibold">WhatsApp Conectado</p>
          <p class="text-xs text-gray-500">Pronto para disparos</p>
        </div>
        <div id="qr-idle" class="flex-col items-center gap-2 text-center">
          <p class="text-4xl mb-2">📵</p>
          <p class="text-sm text-gray-400">Clique em Conectar para gerar o QR Code</p>
        </div>
      </div>
    </div>
  </div>

  <!-- ── TAB: Contatos ── -->
  <div id="p-contacts" class="hidden fade">
    <div class="bg-gray-900/60 border border-gray-800 rounded-xl px-4 py-2.5 mb-3 text-xs text-gray-400">
      Colunas aceitas no CSV: <span class="font-mono text-gray-300">nome, telefone, empresa, extra, vencimento</span>
    </div>
    <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
      <div class="flex gap-2 flex-wrap">
        <input id="search" oninput="filterContacts()" placeholder="Buscar por nome..." class="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm w-44 focus:outline-none focus:border-violet-500"/>
        <select id="filter-group" onchange="filterContacts()" class="bg-gray-900 border border-gray-800 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500 text-gray-400">
          <option value="">Todos os grupos</option>
        </select>
        <label class="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl cursor-pointer transition-colors">
          Importar CSV <input type="file" accept=".csv" onchange="importCSV(event)" class="hidden"/>
        </label>
        <button onclick="exportCSV()" class="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors">Exportar</button>
      </div>
      <div class="flex gap-2">
        <button id="btn-delete-selected" onclick="deleteSelected()" class="hidden px-4 py-2 bg-red-700 hover:bg-red-600 text-white text-sm font-medium rounded-xl transition-colors">🗑 Excluir selecionados</button>
        <button onclick="toggleAddForm()" class="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl transition-colors">+ Adicionar</button>
      </div>
    </div>

    <!-- Groups chips -->
    <div class="flex items-center gap-2 mb-3 flex-wrap">
      <span class="text-xs text-gray-500">Grupo:</span>
      <div id="group-chips" class="flex gap-2 flex-wrap items-center">
        <button onclick="setActiveGroup(null)" id="grp-all" class="px-3 py-1 text-xs rounded-full bg-violet-700 text-white font-medium transition-colors">Todos</button>
      </div>
      <button onclick="openGroupModal()" class="px-3 py-1 text-xs rounded-full bg-gray-800 hover:bg-gray-700 text-gray-400 transition-colors">+ Novo grupo</button>
      <button id="btn-add-group" onclick="showAddToGroupMenu()" class="hidden px-3 py-1 text-xs rounded-full bg-gray-700 hover:bg-violet-700 text-white transition-colors">📂 Adicionar ao grupo</button>
    </div>

    <!-- Add form -->
    <div id="add-form" class="hidden bg-gray-900 border border-gray-800 rounded-2xl p-4 mb-4 fade">
      <p class="text-sm font-semibold mb-3">Novo contato</p>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <input id="f-nome" placeholder="Nome *" autocomplete="off" class="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
        <input id="f-tel" placeholder="Telefone * (ex: 11999990001)" autocomplete="off" inputmode="numeric" class="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
        <input id="f-emp" placeholder="Empresa (opcional)" autocomplete="off" class="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
        <input id="f-ext" placeholder="Info extra (opcional)" autocomplete="off" class="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
      </div>
      <!-- Grupo -->
      <div class="mb-3">
        <div class="flex gap-2 items-center">
          <select id="f-group" class="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500 text-gray-400">
            <option value="">Nenhum grupo</option>
          </select>
          <button type="button" onclick="toggleNewGroupInline()" class="text-xs px-3 py-2 bg-gray-800 hover:bg-violet-700/60 border border-gray-700 text-gray-300 rounded-xl transition-colors whitespace-nowrap">+ Novo grupo</button>
        </div>
        <div id="new-group-inline" class="hidden mt-2 flex gap-2">
          <input id="f-new-group-name" placeholder="Nome do novo grupo" class="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
          <button type="button" onclick="createGroupInline()" class="px-3 py-2 bg-violet-600 hover:bg-violet-500 text-white text-xs rounded-xl">Criar</button>
        </div>
      </div>
      <div class="flex gap-2">
        <button onclick="addContact()" class="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm rounded-xl">Salvar</button>
        <button onclick="toggleAddForm()" class="px-4 py-2 bg-gray-800 text-gray-400 text-sm rounded-xl">Cancelar</button>
      </div>
    </div>

    <div class="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div class="flex items-center justify-between px-4 py-3 border-b border-gray-800">
        <span class="text-xs text-gray-500 uppercase tracking-wider">Contatos</span>
        <span id="contact-count" class="text-xs text-gray-500">0 registros</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-xs text-gray-500 uppercase border-b border-gray-800">
            <th class="px-4 py-2"><input type="checkbox" id="chk-all" onchange="toggleAllContacts(this.checked)" class="accent-violet-600"/></th>
            <th class="text-left px-4 py-2">Nome</th>
            <th class="text-left px-4 py-2">Telefone</th>
            <th class="text-left px-4 py-2">Empresa</th>
            <th class="text-left px-4 py-2">Extra</th>
            <th class="px-4 py-2"></th>
          </tr></thead>
          <tbody id="contacts-tbody"></tbody>
        </table>
        <div id="contacts-empty" class="hidden py-12 text-center text-gray-600">
          <p class="text-4xl mb-2">📭</p>
          <p>Nenhum contato. Importe um CSV ou adicione manualmente.</p>
        </div>
      </div>
    </div>
  </div>

  <!-- ── TAB: Campanha ── -->
  <div id="p-campaign" class="hidden fade">
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">

      <!-- Template -->
      <div class="md:col-span-2 bg-gray-900 border border-gray-800 rounded-2xl p-5">
        <div class="flex items-center justify-between mb-2">
          <p class="text-xs text-gray-500 uppercase tracking-wider">Mensagem</p>
          <div class="flex gap-2 text-xs text-gray-600 flex-wrap">
            <button onclick="insertVar('{nome}')" class="hover:text-violet-400 transition-colors">{nome}</button>
            <button onclick="insertVar('{empresa}')" class="hover:text-violet-400 transition-colors">{empresa}</button>
            <button onclick="insertVar('{extra}')" class="hover:text-violet-400 transition-colors">{extra}</button>
            <button onclick="insertVar('{vencimento}')" class="hover:text-green-400 transition-colors text-green-600">{vencimento}</button>
          </div>
        </div>
        <textarea id="tpl" rows="7" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-violet-500 font-mono"></textarea>
        <div class="flex items-center gap-2 mt-2">
          <button onclick="saveTemplateDraft()" class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors">Salvar rascunho</button>
          <button onclick="openSaveModal()" class="px-3 py-1.5 bg-violet-700 hover:bg-violet-600 text-white text-xs rounded-lg transition-colors">+ Salvar como novo template</button>
          <span id="tpl-saved" class="hidden text-xs text-green-400">✔ Salvo</span>
        </div>
      </div>

      <!-- Config -->
      <div class="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex flex-col gap-4">
        <p class="text-xs text-gray-500 uppercase tracking-wider">Configurações</p>
        <div>
          <label class="text-xs text-gray-400 mb-1 block">Delay mín. (ms)</label>
          <input id="cfg-dmin" type="number" value="${process.env.DELAY_MIN || 8000}" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 mb-1 block">Delay máx. (ms)</label>
          <input id="cfg-dmax" type="number" value="${process.env.DELAY_MAX || 20000}" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
        </div>
        <div>
          <label class="text-xs text-gray-400 mb-1 block">Limite diário</label>
          <input id="cfg-limit" type="number" value="${process.env.DAILY_LIMIT || 150}" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
        </div>
        <label class="flex items-center gap-2 cursor-pointer">
          <input id="cfg-ai" type="checkbox" ${process.env.USE_AI === 'true' ? 'checked' : ''} class="w-4 h-4 rounded accent-violet-600"/>
          <span class="text-sm text-gray-300">Personalizar com IA</span>
        </label>
      </div>
    </div>

    <!-- Templates salvos -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-4">
      <div class="flex items-center justify-between mb-3">
        <p class="text-xs text-gray-500 uppercase tracking-wider">Templates salvos</p>
        <span id="tpl-count" class="text-xs text-gray-600">0 templates</span>
      </div>
      <div id="tpl-list" class="space-y-2">
        <p class="text-xs text-gray-600 text-center py-4">Nenhum template salvo ainda.</p>
      </div>
    </div>

    <!-- Media -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-4">
      <div class="flex items-center justify-between mb-3">
        <p class="text-xs text-gray-500 uppercase tracking-wider">Mídia (opcional)</p>
        <span id="media-badge" class="hidden text-xs px-2 py-0.5 bg-violet-900 text-violet-300 rounded-full"></span>
      </div>
      <div id="media-drop" class="border-2 border-dashed border-gray-700 rounded-xl p-6 text-center cursor-pointer hover:border-violet-600 transition-colors" onclick="document.getElementById('media-input').click()">
        <input id="media-input" type="file" accept="image/*,video/*,audio/*,.pdf" onchange="uploadMedia(event)" class="hidden"/>
        <div id="media-placeholder" class="flex flex-col items-center gap-2">
          <span class="text-3xl">📎</span>
          <p class="text-sm text-gray-400">Clique para anexar imagem, vídeo, áudio ou PDF</p>
          <p class="text-xs text-gray-600">O texto da mensagem vira legenda da mídia</p>
        </div>
        <div id="media-preview" class="hidden flex-col items-center gap-3">
          <img id="prev-img" class="hidden max-h-40 rounded-lg object-contain"/>
          <video id="prev-vid" class="hidden max-h-40 rounded-lg" controls></video>
          <audio id="prev-aud" class="hidden w-full" controls></audio>
          <div id="prev-doc" class="hidden flex items-center gap-3 bg-gray-800 rounded-xl px-4 py-3">
            <span class="text-3xl">📄</span>
            <div class="text-left"><p id="prev-doc-name" class="text-sm font-medium"></p><p class="text-xs text-gray-500">Documento</p></div>
          </div>
          <p id="media-name" class="text-xs text-gray-400"></p>
        </div>
      </div>
      <button id="media-remove" onclick="removeMedia()" class="hidden mt-2 text-xs text-red-400 hover:text-red-300 transition-colors">✕ Remover mídia</button>
    </div>

    <!-- Campaign controls -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-5 mb-4">
      <!-- Group selector -->
      <div class="mb-4 pb-4 border-b border-gray-800">
        <label class="text-xs text-gray-500 uppercase tracking-wider mb-2 block">Grupo de contatos</label>
        <select id="camp-group" onchange="applyCampGroup()" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500">
          <option value="">📋 Todos os contatos</option>
        </select>
      </div>
      <div class="flex items-center justify-between mb-4">
        <div>
          <p class="text-xs text-gray-500 uppercase tracking-wider mb-1">Disparar campanha</p>
          <p id="camp-summary" class="text-sm text-gray-400">— contatos carregados</p>
        </div>
        <div class="flex gap-2">
          <button onclick="startCampaign()" id="btn-start" class="px-5 py-2.5 bg-violet-600 hover:bg-violet-500 text-white font-semibold rounded-xl transition-colors">▶ Disparar</button>
          <button onclick="stopCampaign()" id="btn-stop" class="hidden px-5 py-2.5 bg-red-700 hover:bg-red-600 text-white font-semibold rounded-xl transition-colors">⏹ Parar</button>
        </div>
      </div>

      <!-- Progress -->
      <div id="prog-wrap" class="hidden">
        <div class="flex items-center justify-between text-xs text-gray-500 mb-1">
          <span id="prog-label">0 / 0</span>
          <span id="prog-pct">0%</span>
        </div>
        <div class="w-full bg-gray-800 rounded-full h-2 mb-3">
          <div id="prog-bar" class="bg-violet-600 h-2 rounded-full transition-all duration-500" style="width:0%"></div>
        </div>
        <div class="flex gap-4 text-xs">
          <span class="text-green-400">✔ <span id="stat-sent">0</span> enviadas</span>
          <span class="text-red-400">✘ <span id="stat-fail">0</span> falhas</span>
        </div>
      </div>
    </div>

    <!-- Log -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-4 mb-4">
      <div class="flex items-center justify-between mb-2">
        <p class="text-xs text-gray-500 uppercase tracking-wider">Log em tempo real</p>
        <button onclick="document.getElementById('camp-log').innerHTML=''" class="text-xs text-gray-600 hover:text-gray-400">Limpar</button>
      </div>
      <div id="camp-log" class="font-mono text-xs space-y-0.5 max-h-48 overflow-y-auto text-gray-400"></div>
    </div>

    <!-- Results -->
    <div id="results-wrap" class="hidden bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
      <div class="px-4 py-3 border-b border-gray-800">
        <span class="text-xs text-gray-500 uppercase tracking-wider">Resultados</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead><tr class="text-gray-500 uppercase border-b border-gray-800">
            <th class="text-left px-4 py-2">Nome</th>
            <th class="text-left px-4 py-2">Telefone</th>
            <th class="text-left px-4 py-2">Status</th>
            <th class="text-left px-4 py-2">Hora</th>
          </tr></thead>
          <tbody id="results-tbody"></tbody>
        </table>
      </div>
    </div>
  </div>

</div>

<!-- Modal auto-resposta -->
<div id="auto-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
  <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-lg fade overflow-y-auto max-h-screen">
    <p class="text-sm font-semibold mb-4" id="auto-modal-title">Nova regra de auto-resposta</p>
    <input id="ar-id" type="hidden"/>

    <label class="text-xs text-gray-500 mb-1 block">Nome da regra</label>
    <input id="ar-name" placeholder="Ex: Resposta de interesse" autocomplete="off"
      class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm mb-4 focus:outline-none focus:border-violet-500"/>

    <label class="text-xs text-gray-500 mb-1 block">Campanha associada</label>
    <select id="ar-template" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm mb-4 focus:outline-none focus:border-violet-500">
      <option value="">Todas as campanhas (global)</option>
    </select>

    <label class="text-xs text-gray-500 mb-1 block">Gatilho</label>
    <div class="flex gap-2 mb-3">
      <button id="trg-kw" onclick="setTrigger('keywords')" class="flex-1 py-2 text-xs rounded-xl bg-violet-700 text-white font-medium transition-colors">Palavras-chave</button>
      <button id="trg-any" onclick="setTrigger('any')" class="flex-1 py-2 text-xs rounded-xl bg-gray-800 text-gray-400 transition-colors">Qualquer mensagem</button>
    </div>
    <div id="kw-area" class="mb-4">
      <label class="text-xs text-gray-500 mb-1 block">Palavras-chave (uma por linha, sem acento)</label>
      <textarea id="ar-keywords" rows="3" placeholder="interesse&#10;quero saber&#10;como funciona"
        class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:border-violet-500"></textarea>
    </div>

    <label class="text-xs text-gray-500 mb-1 block">Mensagem de resposta</label>
    <textarea id="ar-response" rows="4" placeholder="Olá {nome}! Obrigado pelo interesse..."
      class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm mb-3 focus:outline-none focus:border-violet-500"></textarea>

    <label class="text-xs text-gray-500 mb-1 block">Mídia (opcional)</label>
    <div class="flex items-center gap-3 mb-4">
      <label class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg cursor-pointer transition-colors">
        Anexar arquivo <input type="file" id="ar-media-input" accept="image/*,video/*,audio/*,.pdf" onchange="uploadAutoMedia(event)" class="hidden"/>
      </label>
      <span id="ar-media-name" class="text-xs text-gray-500">Nenhuma mídia</span>
      <button id="ar-media-remove" onclick="removeAutoMedia()" class="hidden text-xs text-red-400 hover:text-red-300">✕</button>
    </div>

    <div class="flex items-center gap-4 mb-5">
      <div class="flex-1">
        <label class="text-xs text-gray-500 mb-1 block">Delay antes de responder (ms)</label>
        <input id="ar-delay" type="number" value="2000" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
      </div>
      <label class="flex items-center gap-2 cursor-pointer mt-4">
        <input id="ar-active" type="checkbox" checked class="w-4 h-4 accent-violet-600"/>
        <span class="text-sm text-gray-300">Ativa</span>
      </label>
    </div>

    <div class="flex gap-2">
      <button onclick="saveAutoRule()" class="flex-1 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl">Salvar regra</button>
      <button onclick="closeAutoModal()" class="flex-1 py-2 bg-gray-800 text-gray-400 text-sm rounded-xl">Cancelar</button>
    </div>
  </div>
</div>

<!-- Modal novo grupo -->
<div id="group-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50">
  <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 fade">
    <p class="text-sm font-semibold mb-4">Novo grupo</p>
    <input id="grp-name-input" placeholder="Nome do grupo (ex: Clientes Premium)" autocomplete="off"
      class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm mb-4 focus:outline-none focus:border-violet-500"/>
    <div class="flex gap-2">
      <button onclick="createGroup()" class="flex-1 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl">Criar</button>
      <button onclick="closeGroupModal()" class="flex-1 py-2 bg-gray-800 text-gray-400 text-sm rounded-xl">Cancelar</button>
    </div>
  </div>
</div>

<!-- Modal adicionar ao grupo -->
<div id="add-group-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50">
  <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 fade">
    <p class="text-sm font-semibold mb-1">Adicionar contatos ao grupo</p>
    <p id="add-group-count" class="text-xs text-gray-500 mb-4"></p>
    <div id="add-group-list" class="space-y-2 max-h-60 overflow-y-auto mb-4"></div>
    <button onclick="closeAddGroupModal()" class="w-full py-2 bg-gray-800 text-gray-400 text-sm rounded-xl">Fechar</button>
  </div>
</div>

<!-- Modal editar contato -->
<div id="edit-contact-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50">
  <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 fade">
    <p class="text-sm font-semibold mb-4">Editar contato</p>
    <input id="ec-idx" type="hidden"/>
    <div class="grid grid-cols-1 gap-3 mb-4">
      <input id="ec-nome" placeholder="Nome *" autocomplete="off" class="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
      <input id="ec-tel" placeholder="Telefone *" autocomplete="off" inputmode="numeric" class="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
      <input id="ec-emp" placeholder="Empresa (opcional)" autocomplete="off" class="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
      <input id="ec-ext" placeholder="Info extra (opcional)" autocomplete="off" class="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
    </div>
    <div class="flex gap-2">
      <button onclick="saveEditContact()" class="flex-1 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl">Salvar</button>
      <button onclick="closeEditContact()" class="flex-1 py-2 bg-gray-800 text-gray-400 text-sm rounded-xl">Cancelar</button>
    </div>
  </div>
</div>

<!-- Modal salvar template -->
<div id="save-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50">
  <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 fade">
    <p class="text-sm font-semibold mb-4">Salvar template</p>
    <input id="tpl-name-input" placeholder="Nome do template (ex: Promoção de Maio)" autocomplete="off"
      class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm mb-4 focus:outline-none focus:border-violet-500"/>
    <div class="flex gap-2">
      <button onclick="confirmSaveTemplate()" class="flex-1 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl">Salvar</button>
      <button onclick="closeSaveModal()" class="flex-1 py-2 bg-gray-800 text-gray-400 text-sm rounded-xl">Cancelar</button>
    </div>
  </div>
</div>

<script>
let contacts = []
let filtered = []
let selected = new Set()
let pollTimer = null
let groups = []
let activeGroup = null // id do grupo ativo no filtro de contatos

// ── Tabs ─────────────────────────────────────────────────────────────────────
function tab(id) {
  ['conn','contacts','campaign','auto','hist'].forEach(t => {
    document.getElementById('p-'+t).classList.add('hidden')
    document.getElementById('t-'+t).classList.remove('tab-active')
    document.getElementById('t-'+t).classList.add('text-gray-400')
  })
  document.getElementById('p-'+id).classList.remove('hidden')
  document.getElementById('t-'+id).classList.add('tab-active')
  document.getElementById('t-'+id).classList.remove('text-gray-400')
  if (id === 'contacts') { loadContacts(); loadGroupsUI() }
  if (id === 'campaign') { loadTemplate(); updateCampSummary(); loadGroupsForCampaign() }
  if (id === 'auto') { loadAutoList(); checkWebhookStatus() }
  if (id === 'hist') loadHistory()
}

// ── Connection ────────────────────────────────────────────────────────────────
async function checkStatus() {
  try {
    const r = await fetch('/api/status').then(r=>r.json())
    const s = r?.instance?.state || 'close'
    setConnState(s)
    document.getElementById('hd-dot').className = s==='open'?'w-2 h-2 rounded-full bg-green-500':'w-2 h-2 rounded-full bg-gray-600'
    document.getElementById('hd-txt').textContent = s==='open'?'Conectado':'Desconectado'
    return s
  } catch { return 'error' }
}

function setConnState(s) {
  const dot = document.getElementById('c-dot')
  const state = document.getElementById('c-state')
  const qrW = document.getElementById('qr-wrap')
  const qrC = document.getElementById('qr-connected')
  const qrI = document.getElementById('qr-idle')
  if (s === 'open') {
    dot.className='w-3 h-3 rounded-full bg-green-500'
    state.textContent='Conectado'; state.className='text-lg font-semibold text-green-400'
    qrW.classList.add('hidden'); qrC.classList.remove('hidden'); qrI.classList.add('hidden')
    qrC.classList.add('flex')
  } else {
    dot.className='w-3 h-3 rounded-full bg-gray-600'
    state.textContent=s||'Desconectado'; state.className='text-lg font-semibold text-gray-300'
    qrC.classList.add('hidden'); qrC.classList.remove('flex')
  }
}

async function doConnect() {
  document.getElementById('qr-idle').classList.add('hidden')
  document.getElementById('qr-idle').classList.remove('flex')
  const r = await fetch('/api/connect', {method:'POST'}).then(r=>r.json())
  const qrBase64 = r.qrcode?.base64 || r.base64
  if (qrBase64) {
    document.getElementById('qr-img').src = qrBase64
    document.getElementById('qr-wrap').classList.remove('hidden')
    document.getElementById('qr-wrap').classList.add('flex')
  }
}

async function doDisconnect() {
  await fetch('/api/disconnect', {method:'POST'})
  document.getElementById('qr-wrap').classList.add('hidden')
  document.getElementById('qr-wrap').classList.remove('flex')
  document.getElementById('qr-connected').classList.add('hidden')
  document.getElementById('qr-idle').classList.remove('hidden')
  document.getElementById('qr-idle').classList.add('flex')
  setConnState('close')
}

// ── Contacts ──────────────────────────────────────────────────────────────────
async function loadContacts() {
  contacts = await fetch('/api/contacts').then(r=>r.json())
  filtered = [...contacts]
  renderContacts()
}

function filterContacts() {
  const q = (document.getElementById('search')?.value || '').toLowerCase()
  const gid = document.getElementById('filter-group')?.value || ''
  const grpFilter = gid ? (groups.find(g => g.id === gid) || null) : null
  const activeGrp = activeGroup ? (groups.find(g => g.id === activeGroup) || null) : null
  filtered = contacts.filter(c => {
    const tel = c.telefone.replace(/\D/g,'')
    if (activeGrp && !activeGrp.phones.includes(tel)) return false
    if (grpFilter && !grpFilter.phones.includes(tel)) return false
    return !q || (c.nome||'').toLowerCase().includes(q) ||
      (c.telefone||'').includes(q) ||
      (c.empresa||'').toLowerCase().includes(q)
  })
  filtered.sort((a,b) => (a.nome||'').localeCompare(b.nome||'', 'pt-BR'))
  renderContacts()
}

function renderContacts() {
  const tb = document.getElementById('contacts-tbody')
  const empty = document.getElementById('contacts-empty')
  document.getElementById('contact-count').textContent = contacts.length + ' registros'
  updateCampSummary()
  if (!filtered.length) { tb.innerHTML=''; empty.classList.remove('hidden'); return }
  empty.classList.add('hidden')
  tb.innerHTML = filtered.map((c,i) => {
    const realIdx = contacts.indexOf(c)
    const chk = selected.has(realIdx)
    return \`
    <tr class="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors \${chk?'bg-violet-950/20':''}">
      <td class="px-4 py-2.5"><input type="checkbox" \${chk?'checked':''} onchange="toggleContact(\${realIdx},this.checked)" class="accent-violet-600"/></td>
      <td class="px-4 py-2.5 font-medium">\${esc(c.nome)}</td>
      <td class="px-4 py-2.5 font-mono text-gray-400 text-xs">\${esc(c.telefone)}</td>
      <td class="px-4 py-2.5 text-gray-400">\${esc(c.empresa||'—')}</td>
      <td class="px-4 py-2.5 text-gray-500 text-xs">\${esc(c.extra||'—')}</td>
      <td class="px-4 py-2.5 text-right flex items-center justify-end gap-2">
        <button onclick="openEditContact(\${realIdx})" class="text-gray-600 hover:text-violet-400 transition-colors text-xs">✎</button>
        <button onclick="deleteContact(\${realIdx})" class="text-gray-600 hover:text-red-400 transition-colors text-xs">✕</button>
      </td>
    </tr>\`
  }).join('')
}

function toggleContact(idx, checked) {
  checked ? selected.add(idx) : selected.delete(idx)
  updateCampSummary()
  renderContacts()
}

function toggleAllContacts(checked) {
  if (checked) contacts.forEach((_,i) => selected.add(i))
  else selected.clear()
  updateCampSummary()
  renderContacts()
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

function toggleAddForm() {
  const f = document.getElementById('add-form')
  const opening = f.classList.contains('hidden')
  f.classList.toggle('hidden')
  if (opening) {
    const sel = document.getElementById('f-group')
    sel.innerHTML = '<option value="">Nenhum grupo</option>'
    groups.forEach(g => { const o = document.createElement('option'); o.value=g.id; o.textContent=g.name; sel.appendChild(o) })
  }
}

async function addContact() {
  const c = {
    nome: document.getElementById('f-nome').value.trim(),
    telefone: document.getElementById('f-tel').value.trim(),
    empresa: document.getElementById('f-emp').value.trim(),
    extra: document.getElementById('f-ext').value.trim()
  }
  if (!c.nome || !c.telefone) { alert('Nome e telefone obrigatórios'); return }
  contacts.push(c)
  await fetch('/api/contacts', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(contacts) })

  // Adiciona ao grupo se selecionado
  const groupId = document.getElementById('f-group').value
  if (groupId) {
    const grp = groups.find(g => g.id === groupId)
    if (grp) {
      const phone = c.telefone.replace(/\D/g,'')
      if (!grp.phones.includes(phone)) {
        grp.phones.push(phone)
        await fetch(\`/api/groups/\${groupId}\`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ phones: grp.phones }) })
      }
    }
  }

  document.getElementById('f-nome').value=''
  document.getElementById('f-tel').value=''
  document.getElementById('f-emp').value=''
  document.getElementById('f-ext').value=''
  document.getElementById('f-group').value=''
  toggleAddForm()
  filtered = [...contacts]
  renderContacts()
}

function toggleNewGroupInline() {
  const el = document.getElementById('new-group-inline')
  el.classList.toggle('hidden')
  if (!el.classList.contains('hidden')) document.getElementById('f-new-group-name').focus()
}

async function createGroupInline() {
  const name = document.getElementById('f-new-group-name').value.trim()
  if (!name) return
  const res = await fetch('/api/groups', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name }) })
  const grp = await res.json()
  groups.push(grp)
  // Adiciona ao select e seleciona
  const sel = document.getElementById('f-group')
  const opt = document.createElement('option')
  opt.value = grp.id; opt.textContent = grp.name
  sel.appendChild(opt)
  sel.value = grp.id
  document.getElementById('f-new-group-name').value=''
  document.getElementById('new-group-inline').classList.add('hidden')
}

async function deleteContact(idx) {
  if (!confirm('Remover este contato?')) return
  contacts.splice(idx, 1)
  await fetch('/api/contacts', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(contacts) })
  filtered = [...contacts]
  renderContacts()
}

function openEditContact(idx) {
  const c = contacts[idx]
  if (!c) return
  document.getElementById('ec-idx').value = idx
  document.getElementById('ec-nome').value = c.nome || ''
  document.getElementById('ec-tel').value = c.telefone || ''
  document.getElementById('ec-emp').value = c.empresa || ''
  document.getElementById('ec-ext').value = c.extra || ''
  document.getElementById('edit-contact-modal').classList.remove('hidden')
  setTimeout(() => document.getElementById('ec-nome').focus(), 50)
}

function closeEditContact() {
  document.getElementById('edit-contact-modal').classList.add('hidden')
}

async function saveEditContact() {
  const idx = parseInt(document.getElementById('ec-idx').value)
  const nome = document.getElementById('ec-nome').value.trim()
  const telefone = document.getElementById('ec-tel').value.trim()
  if (!nome || !telefone) { alert('Nome e telefone obrigatórios'); return }
  contacts[idx] = {
    ...contacts[idx],
    nome,
    telefone,
    empresa: document.getElementById('ec-emp').value.trim(),
    extra: document.getElementById('ec-ext').value.trim()
  }
  await fetch('/api/contacts', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(contacts) })
  filtered = [...contacts]
  closeEditContact()
  renderContacts()
}

function importCSV(e) {
  const file = e.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = async ev => {
    const r = await fetch('/api/contacts/import', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ csv: ev.target.result })
    }).then(r=>r.json())
    contacts = r.contacts || []
    filtered = [...contacts]
    renderContacts()
    let msg = \`Importados: \${r.imported} contatos\`
    if (r.invalid > 0) msg += \`\n\${r.invalid} ignorados (sem nome ou telefone vazio)\`
    if (r.invalidSamples?.length) msg += \`\nExemplos ignorados: \${r.invalidSamples.join(', ')}\`
    alert(msg)
  }
  reader.readAsText(file)
  e.target.value = ''
}

function exportCSV() {
  const headers = ['nome','telefone','empresa','extra']
  const rows = contacts.map(c => headers.map(h => \`"\${(c[h]||'').replace(/"/g,'""')}"\`).join(','))
  const csv = [headers.join(','), ...rows].join('\\n')
  const a = document.createElement('a')
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv)
  a.download = 'contatos.csv'
  a.click()
}

// ── Campaign ──────────────────────────────────────────────────────────────────
async function loadTemplate() {
  const r = await fetch('/api/template').then(r=>r.json())
  document.getElementById('tpl').value = r.template || ''
  await loadTemplateList()
}

async function saveTemplateDraft() {
  const tpl = document.getElementById('tpl').value
  await fetch('/api/template', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({template:tpl}) })
  const s = document.getElementById('tpl-saved')
  s.classList.remove('hidden'); setTimeout(()=>s.classList.add('hidden'), 2000)
}

function openSaveModal() {
  const tpl = document.getElementById('tpl').value.trim()
  if (!tpl) { alert('Escreva a mensagem antes de salvar.'); return }
  document.getElementById('tpl-name-input').value = ''
  document.getElementById('save-modal').classList.remove('hidden')
  setTimeout(() => document.getElementById('tpl-name-input').focus(), 50)
}

function closeSaveModal() {
  document.getElementById('save-modal').classList.add('hidden')
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSaveModal() })

async function confirmSaveTemplate() {
  const name = document.getElementById('tpl-name-input').value.trim()
  if (!name) { alert('Dê um nome ao template.'); return }
  const content = document.getElementById('tpl').value.trim()
  await fetch('/api/templates', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, content })
  })
  closeSaveModal()
  await loadTemplateList()
}

async function loadTemplateList() {
  const list = await fetch('/api/templates').then(r => r.json())
  const el = document.getElementById('tpl-list')
  document.getElementById('tpl-count').textContent = list.length + ' template' + (list.length !== 1 ? 's' : '')
  if (!list.length) { el.innerHTML = '<p class="text-xs text-gray-600 text-center py-4">Nenhum template salvo ainda.</p>'; return }
  el.innerHTML = list.map(t => \`
    <div class="flex items-center gap-3 bg-gray-800 hover:bg-gray-750 border border-gray-700 rounded-xl px-4 py-3 group transition-colors">
      <div class="flex-1 min-w-0 cursor-pointer" onclick="loadSavedTemplate('\${t.id}')">
        <p class="text-sm font-medium text-white truncate">\${esc(t.name)}</p>
        <p class="text-xs text-gray-500 truncate mt-0.5">\${esc(t.content.slice(0,80))}\${t.content.length>80?'...':''}</p>
      </div>
      <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onclick="loadSavedTemplate('\${t.id}')" class="px-2 py-1 bg-violet-700 hover:bg-violet-600 text-white text-xs rounded-lg transition-colors">Usar</button>
        <button onclick="updateSavedTemplate('\${t.id}','\${esc(t.name)}')" class="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded-lg transition-colors">Atualizar</button>
        <button onclick="deleteSavedTemplate('\${t.id}')" class="px-2 py-1 bg-gray-700 hover:bg-red-700 text-gray-300 text-xs rounded-lg transition-colors">✕</button>
      </div>
    </div>\`).join('')
}

async function loadSavedTemplate(id) {
  const list = await fetch('/api/templates').then(r => r.json())
  const t = list.find(t => t.id === id)
  if (!t) return
  document.getElementById('tpl').value = t.content
  window._activeTplId = t.id
  window._activeTplName = t.name
  document.getElementById('tpl').scrollIntoView({ behavior: 'smooth', block: 'center' })
  document.getElementById('tpl').focus()
}

async function updateSavedTemplate(id, currentName) {
  const content = document.getElementById('tpl').value.trim()
  if (!content) { alert('Editor está vazio. Carregue o template primeiro clicando em "Usar".'); return }
  const name = prompt('Nome do template:', currentName)
  if (name === null) return
  await fetch('/api/templates/' + id, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name: name || currentName, content }) })
  await loadTemplateList()
  const s = document.getElementById('tpl-saved')
  s.classList.remove('hidden'); setTimeout(()=>s.classList.add('hidden'), 2000)
}

async function deleteSavedTemplate(id) {
  if (!confirm('Deletar este template?')) return
  await fetch('/api/templates/' + id, { method: 'DELETE' })
  await loadTemplateList()
}

function insertVar(v) {
  const ta = document.getElementById('tpl')
  const start = ta.selectionStart, end = ta.selectionEnd
  ta.value = ta.value.slice(0,start) + v + ta.value.slice(end)
  ta.focus(); ta.setSelectionRange(start+v.length, start+v.length)
}

function updateCampSummary() {
  const n = selected.size > 0 ? selected.size : contacts.length
  const label = selected.size > 0 ? \`\${selected.size} selecionados de \${contacts.length}\` : \`\${contacts.length} contatos (todos)\`
  document.getElementById('camp-summary').textContent = label
  const btn = document.getElementById('btn-delete-selected')
  if (btn) {
    btn.classList.toggle('hidden', selected.size === 0)
    btn.textContent = \`🗑 Excluir \${selected.size} selecionado\${selected.size !== 1 ? 's' : ''}\`
  }
  const btnGrp = document.getElementById('btn-add-group')
  if (btnGrp) btnGrp.classList.toggle('hidden', selected.size === 0)
}

async function deleteSelected() {
  if (!selected.size) return
  if (!confirm(\`Excluir \${selected.size} contato\${selected.size !== 1 ? 's' : ''}?\`)) return
  contacts = contacts.filter((_, i) => !selected.has(i))
  selected.clear()
  await fetch('/api/contacts', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(contacts) })
  filtered = [...contacts]
  renderContacts()
}

async function startCampaign() {
  const state = await checkStatus()
  if (state !== 'open') { alert('WhatsApp não conectado. Conecte primeiro na aba Conexão.'); return }
  if (!contacts.length) { alert('Nenhum contato. Adicione na aba Contatos.'); return }
  const tpl = document.getElementById('tpl').value.trim()
  if (!tpl) { alert('Mensagem vazia.'); return }
  const targetContacts = selected.size > 0 ? contacts.filter((_,i) => selected.has(i)) : contacts
  const limit = parseInt(document.getElementById('cfg-limit').value)
  const finalCount = Math.min(targetContacts.length, limit)
  const selLabel = selected.size > 0 ? \`\${selected.size} selecionados\` : 'todos os contatos'
  if (!confirm(\`Disparar para \${finalCount} contatos (\${selLabel})?\`)) return

  document.getElementById('btn-start').classList.add('hidden')
  document.getElementById('btn-stop').classList.remove('hidden')
  document.getElementById('prog-wrap').classList.remove('hidden')
  document.getElementById('results-wrap').classList.add('hidden')
  document.getElementById('camp-log').innerHTML = ''
  document.getElementById('results-tbody').innerHTML = ''

  const mediaInfo = await fetch('/api/media').then(r => r.json())
  await fetch('/api/campaign/start', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      contacts: targetContacts,
      template: tpl,
      delayMin: parseInt(document.getElementById('cfg-dmin').value),
      delayMax: parseInt(document.getElementById('cfg-dmax').value),
      limit,
      useAI: document.getElementById('cfg-ai').checked,
      useMedia: !!mediaInfo,
      templateId: window._activeTplId || null,
      templateName: window._activeTplName || null
    })
  })

  pollTimer = setInterval(pollProgress, 1000)
}

async function stopCampaign() {
  await fetch('/api/campaign/stop', {method:'POST'})
}

let lastLogLen = 0
async function pollProgress() {
  const r = await fetch('/api/campaign/progress').then(r=>r.json())
  const pct = r.total ? Math.round((r.sent+r.failed)/r.total*100) : 0
  document.getElementById('prog-bar').style.width = pct + '%'
  document.getElementById('prog-label').textContent = (r.sent+r.failed) + ' / ' + r.total
  document.getElementById('prog-pct').textContent = pct + '%'
  document.getElementById('stat-sent').textContent = r.sent
  document.getElementById('stat-fail').textContent = r.failed

  const logEl = document.getElementById('camp-log')
  if (r.log.length > lastLogLen) {
    const newEntries = r.log.slice(lastLogLen)
    newEntries.forEach(e => {
      const cl = e.t==='ok'?'text-green-400':e.t==='err'?'text-red-400':e.t==='warn'?'text-amber-400':'text-gray-400'
      logEl.innerHTML += \`<div class="\${cl}">\${esc(e.m)}</div>\`
    })
    logEl.scrollTop = logEl.scrollHeight
    lastLogLen = r.log.length
  }

  if (!r.running) {
    clearInterval(pollTimer)
    lastLogLen = 0
    document.getElementById('btn-start').classList.remove('hidden')
    document.getElementById('btn-stop').classList.add('hidden')
    renderResults(r.results)
  }
}

function renderResults(results) {
  if (!results.length) return
  document.getElementById('results-wrap').classList.remove('hidden')
  document.getElementById('results-tbody').innerHTML = results.map(r => \`
    <tr class="border-b border-gray-800/50">
      <td class="px-4 py-2">\${esc(r.nome)}</td>
      <td class="px-4 py-2 font-mono text-gray-500">\${esc(r.telefone)}</td>
      <td class="px-4 py-2"><span class="\${r.status==='enviado'?'text-green-400':'text-red-400'}">\${r.status}</span></td>
      <td class="px-4 py-2 text-gray-500">\${r.ts||''}</td>
    </tr>\`).join('')
}

// ── Media ─────────────────────────────────────────────────────────────────────
async function uploadMedia(e) {
  const file = e.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = async ev => {
    const dataUrl = ev.target.result
    const base64 = dataUrl.split(',')[1]
    const r = await fetch('/api/media/upload', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ base64, mimetype: file.type, filename: file.name })
    }).then(r => r.json())
    showMediaPreview(r.mediatype, file.name, dataUrl)
  }
  reader.readAsDataURL(file)
  e.target.value = ''
}

function showMediaPreview(mediatype, filename, dataUrl) {
  document.getElementById('media-placeholder').classList.add('hidden')
  document.getElementById('media-preview').classList.remove('hidden')
  document.getElementById('media-preview').classList.add('flex')
  document.getElementById('media-name').textContent = filename
  document.getElementById('media-remove').classList.remove('hidden')
  document.getElementById('media-badge').textContent = { image: '🖼 Imagem', video: '🎥 Vídeo', audio: '🎵 Áudio', document: '📄 PDF' }[mediatype] || mediatype
  document.getElementById('media-badge').classList.remove('hidden')
  document.getElementById('prev-img').classList.add('hidden')
  document.getElementById('prev-vid').classList.add('hidden')
  document.getElementById('prev-aud').classList.add('hidden')
  document.getElementById('prev-doc').classList.add('hidden')
  if (mediatype === 'image') { const el = document.getElementById('prev-img'); el.src = dataUrl; el.classList.remove('hidden') }
  else if (mediatype === 'video') { const el = document.getElementById('prev-vid'); el.src = dataUrl; el.classList.remove('hidden') }
  else if (mediatype === 'audio') { const el = document.getElementById('prev-aud'); el.src = dataUrl; el.classList.remove('hidden') }
  else { document.getElementById('prev-doc').classList.remove('hidden'); document.getElementById('prev-doc-name').textContent = filename }
}

async function removeMedia() {
  await fetch('/api/media', { method: 'DELETE' })
  document.getElementById('media-placeholder').classList.remove('hidden')
  document.getElementById('media-preview').classList.add('hidden')
  document.getElementById('media-preview').classList.remove('flex')
  document.getElementById('media-remove').classList.add('hidden')
  document.getElementById('media-badge').classList.add('hidden')
  document.getElementById('prev-img').src = ''
  document.getElementById('prev-vid').src = ''
  document.getElementById('prev-aud').src = ''
}

// ── Auto-respostas ────────────────────────────────────────────────────────────
let arMediaData = null // { base64, mimetype, filename } para modal

function setTrigger(type) {
  document.getElementById('kw-area').style.display = type === 'keywords' ? '' : 'none'
  document.getElementById('trg-kw').className = \`flex-1 py-2 text-xs rounded-xl \${type==='keywords'?'bg-violet-700 text-white font-medium':'bg-gray-800 text-gray-400'} transition-colors\`
  document.getElementById('trg-any').className = \`flex-1 py-2 text-xs rounded-xl \${type==='any'?'bg-violet-700 text-white font-medium':'bg-gray-800 text-gray-400'} transition-colors\`
  document.getElementById('trg-kw').dataset.active = type === 'keywords'
}

function openAutoModal(rule) {
  arMediaData = null
  document.getElementById('ar-id').value = rule?.id || ''
  document.getElementById('auto-modal-title').textContent = rule ? 'Editar regra' : 'Nova regra de auto-resposta'
  document.getElementById('ar-name').value = rule?.name || ''
  document.getElementById('ar-keywords').value = (rule?.keywords || []).join('\\n')
  document.getElementById('ar-response').value = rule?.response || ''
  document.getElementById('ar-delay').value = rule?.delay || 2000
  document.getElementById('ar-active').checked = rule?.active !== false
  document.getElementById('ar-media-name').textContent = rule?.mediaFilename || 'Nenhuma mídia'
  document.getElementById('ar-media-remove').classList.toggle('hidden', !rule?.mediaFilename)
  if (rule?.mediaBase64) arMediaData = { base64: rule.mediaBase64, mimetype: rule.mediaMimetype, filename: rule.mediaFilename }
  setTrigger(rule?.trigger || 'keywords')
  // Popula select de templates
  fetch('/api/templates').then(r=>r.json()).then(templates => {
    const sel = document.getElementById('ar-template')
    sel.innerHTML = '<option value="">Todas as campanhas (global)</option>' +
      templates.map(t => '<option value="' + t.id + '">' + esc(t.name) + '</option>').join('')
    sel.value = rule?.templateId || ''
  })
  document.getElementById('auto-modal').classList.remove('hidden')
}

function closeAutoModal() {
  document.getElementById('auto-modal').classList.add('hidden')
  arMediaData = null
}

function uploadAutoMedia(e) {
  const file = e.target.files[0]; if (!file) return
  const reader = new FileReader()
  reader.onload = ev => {
    arMediaData = { base64: ev.target.result.split(',')[1], mimetype: file.type, filename: file.name }
    document.getElementById('ar-media-name').textContent = file.name
    document.getElementById('ar-media-remove').classList.remove('hidden')
  }
  reader.readAsDataURL(file)
  e.target.value = ''
}

function removeAutoMedia() {
  arMediaData = null
  document.getElementById('ar-media-name').textContent = 'Nenhuma mídia'
  document.getElementById('ar-media-remove').classList.add('hidden')
}

async function saveAutoRule() {
  const name = document.getElementById('ar-name').value.trim()
  if (!name) { alert('Nome obrigatório'); return }
  const trigger = document.getElementById('trg-kw').dataset.active === 'true' ? 'keywords' : 'any'
  const keywords = document.getElementById('ar-keywords').value.split(/[\\n\/,]+/).map(k=>k.trim()).filter(Boolean)
  if (trigger === 'keywords' && !keywords.length) { alert('Adicione pelo menos uma palavra-chave'); return }
  const id = document.getElementById('ar-id').value
  const sel = document.getElementById('ar-template')
  const templateId = sel.value || null
  const templateName = templateId ? sel.options[sel.selectedIndex].text : null
  const payload = {
    name, trigger, keywords,
    templateId, templateName,
    response: document.getElementById('ar-response').value,
    delay: parseInt(document.getElementById('ar-delay').value) || 2000,
    active: document.getElementById('ar-active').checked,
    mediaBase64: arMediaData?.base64 || null,
    mediaMimetype: arMediaData?.mimetype || null,
    mediaFilename: arMediaData?.filename || null
  }
  if (id) {
    await fetch('/api/autoreplies/' + id, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
  } else {
    await fetch('/api/autoreplies', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) })
  }
  closeAutoModal()
  await loadAutoList()
}

async function loadAutoList() {
  const list = await fetch('/api/autoreplies').then(r=>r.json())
  const el = document.getElementById('auto-list')
  if (!list.length) {
    el.innerHTML = '<div class="text-center py-12 text-gray-600"><p class="text-4xl mb-2">🤖</p><p>Nenhuma regra criada ainda.</p></div>'
    return
  }
  el.innerHTML = list.map((r,i) => \`
    <div class="bg-gray-900 border \${r.active?'border-gray-700':'border-gray-800 opacity-60'} rounded-2xl p-4 flex gap-4 items-start">
      <div class="flex flex-col items-center gap-1 pt-0.5">
        <span class="text-lg">\${r.trigger==='any'?'🌐':'🔑'}</span>
        <span class="text-xs text-gray-600">#\${i+1}</span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1">
          <p class="text-sm font-semibold">\${esc(r.name)}</p>
          <span class="\${r.active?'bg-green-900 text-green-400':'bg-gray-800 text-gray-500'} text-xs px-2 py-0.5 rounded-full">\${r.active?'Ativa':'Inativa'}</span>
          \${r.mediaFilename?'<span class="text-xs bg-violet-900 text-violet-300 px-2 py-0.5 rounded-full">📎 '+esc(r.mediaFilename)+'</span>':''}
          \${r.templateName?'<span class="text-xs bg-blue-900 text-blue-300 px-2 py-0.5 rounded-full">📋 '+esc(r.templateName)+'</span>':'<span class="text-xs bg-gray-800 text-gray-500 px-2 py-0.5 rounded-full">Global</span>'}
        </div>
        \${r.trigger==='keywords'?'<p class="text-xs text-gray-500 mb-1">Palavras: <span class="text-violet-400">'+r.keywords.map(k=>esc(k)).join(', ')+'</span></p>':'<p class="text-xs text-amber-500 mb-1">Qualquer mensagem recebida</p>'}
        <p class="text-xs text-gray-400 truncate">\${esc((r.response||'').slice(0,100))}\${(r.response||'').length>100?'...':''}</p>
      </div>
      <div class="flex gap-2 shrink-0">
        <button onclick="toggleAutoRule('\${r.id}',\${!r.active})" class="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors">\${r.active?'Pausar':'Ativar'}</button>
        <button onclick="openAutoModal(\${JSON.stringify(r).replace(/"/g,'&quot;')})" class="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors">Editar</button>
        <button onclick="deleteAutoRule('\${r.id}')" class="px-2 py-1 text-xs bg-gray-800 hover:bg-red-700 text-gray-400 hover:text-white rounded-lg transition-colors">✕</button>
      </div>
    </div>\`).join('')
}

async function toggleAutoRule(id, active) {
  await fetch('/api/autoreplies/'+id, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({active}) })
  await loadAutoList()
}

async function deleteAutoRule(id) {
  if (!confirm('Deletar esta regra?')) return
  await fetch('/api/autoreplies/'+id, { method:'DELETE' })
  await loadAutoList()
}

async function checkWebhookStatus() {
  try {
    const r = await fetch('/api/status').then(r=>r.json())
    const connected = r?.instance?.state === 'open'
    document.getElementById('webhook-status').textContent = connected
      ? '✔ Webhook ativo — respostas automáticas funcionando'
      : '⚠ WhatsApp desconectado — conecte na aba Conexão'
    document.getElementById('webhook-status').className = connected ? 'text-xs text-green-500 mt-0.5' : 'text-xs text-amber-500 mt-0.5'
  } catch {}
}

// ── Grupos ───────────────────────────────────────────────────────────────────
async function loadGroupsUI() {
  groups = await fetch('/api/groups').then(r => r.json())
  renderGroupChips()
  // Atualiza select de filtro
  const sel = document.getElementById('filter-group')
  if (sel) {
    const cur = sel.value
    sel.innerHTML = '<option value="">Todos os grupos</option>'
    groups.forEach(g => { const o = document.createElement('option'); o.value=g.id; o.textContent=g.name; sel.appendChild(o) })
    if (cur) sel.value = cur
  }
}

function renderGroupChips() {
  const el = document.getElementById('group-chips')
  if (!el) return
  const allBtn = \`<button onclick="setActiveGroup(null)" id="grp-all" class="px-3 py-1 text-xs rounded-full \${!activeGroup ? 'bg-violet-700 text-white font-medium' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'} transition-colors">Todos (\${contacts.length})</button>\`
  const chips = groups.map(g => \`
    <span class="flex items-center gap-1">
      <button onclick="setActiveGroup('\${g.id}')" class="px-3 py-1 text-xs rounded-full \${activeGroup===g.id ? 'bg-violet-700 text-white font-medium' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'} transition-colors">
        📁 \${esc(g.name)} (\${g.phones.length})
      </button>
      <button onclick="deleteGroup('\${g.id}')" class="text-gray-600 hover:text-red-400 text-xs transition-colors">✕</button>
    </span>\`).join('')
  el.innerHTML = allBtn + chips
}

function setActiveGroup(id) {
  activeGroup = id
  renderGroupChips()
  filterContacts()
}

function openGroupModal() {
  document.getElementById('grp-name-input').value = ''
  document.getElementById('group-modal').classList.remove('hidden')
  setTimeout(() => document.getElementById('grp-name-input').focus(), 50)
}

function closeGroupModal() { document.getElementById('group-modal').classList.add('hidden') }

async function createGroup() {
  const name = document.getElementById('grp-name-input').value.trim()
  if (!name) { alert('Nome obrigatório'); return }
  await fetch('/api/groups', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name }) })
  closeGroupModal()
  await loadGroupsUI()
}

async function deleteGroup(id) {
  if (!confirm('Excluir este grupo? Os contatos não serão deletados.')) return
  await fetch('/api/groups/' + id, { method:'DELETE' })
  if (activeGroup === id) activeGroup = null
  await loadGroupsUI()
  filterContacts()
}

function showAddToGroupMenu() {
  if (!selected.size) return
  const count = selected.size
  document.getElementById('add-group-count').textContent = count + ' contato' + (count !== 1 ? 's' : '') + ' selecionado' + (count !== 1 ? 's' : '')
  const list = document.getElementById('add-group-list')
  if (!groups.length) {
    list.innerHTML = '<p class="text-xs text-gray-500 text-center py-4">Nenhum grupo criado. Crie um grupo primeiro.</p>'
  } else {
    list.innerHTML = groups.map(g => \`
      <button onclick="addSelectedToGroup('\${g.id}')" class="w-full text-left px-4 py-2.5 bg-gray-800 hover:bg-violet-900 rounded-xl text-sm transition-colors">
        📁 \${esc(g.name)} <span class="text-xs text-gray-500">(\${g.phones.length} contatos)</span>
      </button>\`).join('')
  }
  document.getElementById('add-group-modal').classList.remove('hidden')
}

function closeAddGroupModal() { document.getElementById('add-group-modal').classList.add('hidden') }

async function addSelectedToGroup(groupId) {
  const grp = groups.find(g => g.id === groupId)
  if (!grp) return
  const selectedPhones = contacts.filter((_,i) => selected.has(i)).map(c => c.telefone.replace(/\D/g,''))
  const merged = [...new Set([...grp.phones, ...selectedPhones])]
  await fetch('/api/groups/' + groupId, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ phones: merged }) })
  closeAddGroupModal()
  await loadGroupsUI()
  alert(\`\${selectedPhones.length} contato(s) adicionado(s) ao grupo "\${grp.name}".\`)
}

async function loadGroupsForCampaign() {
  groups = await fetch('/api/groups').then(r => r.json())
  const sel = document.getElementById('camp-group')
  if (!sel) return
  sel.innerHTML = '<option value="">📋 Todos os contatos</option>' +
    groups.map(g => \`<option value="\${g.id}">📁 \${esc(g.name)} (\${g.phones.length} contatos)</option>\`).join('')
}

function applyCampGroup() {
  const groupId = document.getElementById('camp-group').value
  if (!groupId) {
    selected.clear()
  } else {
    const grp = groups.find(g => g.id === groupId)
    if (!grp) return
    selected.clear()
    contacts.forEach((c, i) => {
      const phone = c.telefone.replace(/\D/g, '')
      if (grp.phones.includes(phone)) selected.add(i)
    })
  }
  updateCampSummary()
  renderContacts()
}

// ── Histórico ─────────────────────────────────────────────────────────────────
async function loadHistory() {
  const history = await fetch('/api/campaign/history').then(r => r.json())
  renderHistory(history)
}

function renderHistory(history) {
  // Anti-spam: última mensagem por contato
  const lastByPhone = {}
  for (const entry of [...history].reverse()) {
    for (const c of (entry.contacts || [])) {
      const p = (c.telefone || '').replace(/\D/g, '')
      if (!lastByPhone[p]) lastByPhone[p] = { nome: c.nome, date: entry.sentAt, campaign: entry.templateName }
    }
  }
  const antispam = document.getElementById('antispam-list')
  const phones = Object.keys(lastByPhone)
  if (!phones.length) {
    antispam.innerHTML = '<p class="text-xs text-gray-600 text-center py-4">Nenhuma campanha enviada ainda.</p>'
  } else {
    antispam.innerHTML = phones.map(p => {
      const info = lastByPhone[p]
      const days = Math.floor((Date.now() - new Date(info.date)) / 86400000)
      const risk = days === 0 ? 'text-red-400' : days < 3 ? 'text-amber-400' : 'text-green-400'
      const label = days === 0 ? '⚠ Hoje' : days === 1 ? '1 dia atrás' : days + ' dias atrás'
      return \`<div class="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-gray-800/50">
        <div>
          <span class="text-sm text-gray-200">\${esc(info.nome)}</span>
          <span class="text-xs text-gray-500 ml-2">\${esc(info.campaign)}</span>
        </div>
        <span class="text-xs \${risk} font-medium">\${label}</span>
      </div>\`
    }).join('')
  }

  // Campaign list
  const histEl = document.getElementById('hist-list')
  if (!history.length) {
    histEl.innerHTML = '<p class="text-xs text-gray-600 text-center py-8">Nenhuma campanha enviada ainda.</p>'
    return
  }
  histEl.innerHTML = history.map((h, i) => {
    const dt = new Date(h.sentAt)
    const dateStr = dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'})
    const contactList = (h.contacts || []).map(c => \`<li>\${esc(c.nome)} — \${esc(c.telefone)}</li>\`).join('')
    return \`<div class="px-4 py-3">
      <div class="flex items-center justify-between mb-1">
        <div class="flex items-center gap-3">
          <span class="text-sm font-medium text-white">\${esc(h.templateName || 'Campanha #' + (i+1))}</span>
          <span class="text-xs text-green-400">✔ \${h.sent || h.phones?.length || 0} enviadas</span>
          \${(h.failed||0) > 0 ? \`<span class="text-xs text-red-400">✘ \${h.failed} falhas</span>\` : ''}
        </div>
        <span class="text-xs text-gray-500">\${dateStr}</span>
      </div>
      \${contactList ? \`<details class="mt-1"><summary class="text-xs text-gray-500 cursor-pointer hover:text-gray-300">Ver contatos (\${(h.contacts||[]).length})</summary>
        <ul class="mt-1 space-y-0.5 text-xs text-gray-400 pl-3 font-mono">\${contactList}</ul></details>\` : ''}
    </div>\`
  }).join('')
}

// ── Init ──────────────────────────────────────────────────────────────────────
checkStatus()
setInterval(checkStatus, 8000)
</script>
</body>
</html>` }

// ── Landing page ──────────────────────────────────────────────────────────────

const LANDING_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZapVibe — Disparador Inteligente de WhatsApp com IA</title>
<meta name="description" content="Envie mensagens personalizadas no WhatsApp com inteligência artificial. Automatize sua comunicação, dispare campanhas e responda clientes automaticamente com ZapVibe.">
<meta name="keywords" content="disparador whatsapp, whatsapp marketing, automação whatsapp, envio em massa whatsapp, bot whatsapp, mensagens automáticas whatsapp">
<script src="https://cdn.tailwindcss.com"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{font-family:'Inter',sans-serif}
.gradient-text{background:linear-gradient(135deg,#7c3aed,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.card-hover{transition:all .2s;border:1px solid transparent}
.card-hover:hover{border-color:rgb(124 58 237 / 0.4);transform:translateY(-2px)}
.btn-wpp{background:#25D366;transition:background .2s}.btn-wpp:hover{background:#1ebe5d}
</style>
</head>
<body class="bg-gray-950 text-white">

<!-- Nav -->
<nav class="border-b border-gray-800/50 sticky top-0 bg-gray-950/90 backdrop-blur z-50">
  <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
    <div class="flex items-center gap-2">
      <div class="w-8 h-8 rounded-xl bg-violet-600 flex items-center justify-center text-base">⚡</div>
      <span class="font-bold text-lg">ZapVibe</span>
    </div>
    <div class="flex items-center gap-2">
      <a href="http://wa.link/k3gl1y" target="_blank" class="btn-wpp hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 text-white text-xs font-medium rounded-xl">💬 Suporte</a>
      <a href="/login" class="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors">Entrar</a>
      <a href="/register" class="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl transition-colors">Testar grátis</a>
    </div>
  </div>
</nav>

<!-- Hero -->
<section class="max-w-6xl mx-auto px-4 pt-20 pb-16 text-center">
  <div class="inline-flex items-center gap-2 bg-green-950/60 border border-green-700/40 text-green-300 text-xs font-medium px-3 py-1.5 rounded-full mb-6">
    <span class="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse"></span>
    7 dias grátis — sem cartão de crédito
  </div>
  <h1 class="text-4xl sm:text-5xl md:text-6xl font-extrabold leading-tight mb-6">
    Dispare mensagens no<br><span class="gradient-text">WhatsApp com IA</span>
  </h1>
  <p class="text-gray-400 text-lg max-w-2xl mx-auto mb-10">
    Envie campanhas personalizadas para centenas de contatos, responda automaticamente e acompanhe tudo em um painel simples. Sem complicação, sem risco de ban.
  </p>
  <div class="flex flex-col sm:flex-row gap-3 justify-center">
    <a href="/register" class="px-6 py-3.5 bg-violet-600 hover:bg-violet-500 text-white font-semibold rounded-xl transition-colors text-base">Testar 7 dias grátis →</a>
    <a href="#features" class="px-6 py-3.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-xl transition-colors text-base">Ver funcionalidades</a>
  </div>
  <p class="text-xs text-gray-600 mt-4">Sem cartão de crédito · Acesso liberado em minutos</p>
</section>

<!-- Features -->
<section id="features" class="max-w-6xl mx-auto px-4 py-16">
  <h2 class="text-2xl sm:text-3xl font-bold text-center mb-4">Tudo que você precisa para vender pelo WhatsApp</h2>
  <p class="text-gray-400 text-center mb-12 max-w-xl mx-auto">Uma plataforma completa para escalar seu negócio com automação inteligente de mensagens.</p>
  <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
    ${[
      ['📤','Disparos em massa','Envie mensagens para centenas de contatos com delay inteligente para evitar bloqueios. CSV em segundos.'],
      ['🤖','IA na personalização','Cada mensagem reescrita pela IA para soar natural e pessoal. Mais abertura, mais respostas.'],
      ['💬','Auto-respostas','Configure regras automáticas por palavras-chave. Atenda leads enquanto você dorme.'],
      ['📋','Templates prontos','Crie e salve templates para diferentes campanhas. Reutilize com 1 clique.'],
      ['📊','Histórico detalhado','Veja quem recebeu, quando e os resultados de cada campanha em tempo real.'],
      ['🔗','Conecte seu celular','Use seu próprio número do WhatsApp. Sem precisar de número virtual ou aprovação.'],
    ].map(([icon, title, desc]) => `
    <div class="card-hover bg-gray-900 rounded-2xl p-5">
      <div class="text-3xl mb-3">${icon}</div>
      <h3 class="font-semibold text-base mb-2">${title}</h3>
      <p class="text-sm text-gray-400 leading-relaxed">${desc}</p>
    </div>`).join('')}
  </div>
</section>

<!-- CTA -->
<section class="max-w-3xl mx-auto px-4 py-16 text-center">
  <div class="bg-gradient-to-br from-violet-950/60 to-purple-950/60 border border-violet-800/40 rounded-3xl p-10">
    <h2 class="text-2xl sm:text-3xl font-bold mb-4">Comece grátis hoje mesmo</h2>
    <p class="text-gray-400 mb-8">Crie sua conta em 1 minuto e teste por 7 dias sem pagar nada.</p>
    <a href="/register" class="inline-block px-8 py-3.5 bg-violet-600 hover:bg-violet-500 text-white font-semibold rounded-xl transition-colors text-base">Criar conta grátis →</a>
    <p class="text-xs text-gray-600 mt-4">Dúvidas? <a href="http://wa.link/k3gl1y" target="_blank" class="text-green-500 hover:text-green-400">Fale com a gente no WhatsApp</a></p>
  </div>
</section>

<!-- Suporte flutuante -->
<a href="http://wa.link/k3gl1y" target="_blank"
   class="fixed bottom-5 right-5 btn-wpp text-white px-4 py-3 rounded-2xl shadow-lg flex items-center gap-2 text-sm font-medium z-50">
  💬 <span class="hidden sm:inline">Suporte via WhatsApp</span>
</a>

<!-- Footer -->
<footer class="border-t border-gray-800/50 py-8 text-center text-xs text-gray-600">
  <p>© ${new Date().getFullYear()} ZapVibe. Todos os direitos reservados. ·
    <a href="http://wa.link/k3gl1y" target="_blank" class="hover:text-gray-400">Suporte</a>
  </p>
</footer>

</body>
</html>`

// ── Register page ─────────────────────────────────────────────────────────────

const REGISTER_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZapVibe — Criar conta grátis</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');*{font-family:'Inter',sans-serif}</style>
</head>
<body class="bg-gray-950 text-white min-h-screen flex items-center justify-center px-4">
<div class="w-full max-w-sm">
  <div class="mb-6"><a href="/" class="inline-flex items-center gap-2 text-sm font-medium text-violet-400 hover:text-violet-300 transition-colors">← Voltar ao início</a></div>
  <div class="flex flex-col items-center mb-8">
    <div class="w-12 h-12 rounded-2xl bg-violet-600 flex items-center justify-center text-2xl mb-3">⚡</div>
    <h1 class="text-xl font-bold">ZapVibe</h1>
    <p class="text-sm text-gray-500 mt-1">7 dias grátis — sem cartão de crédito</p>
  </div>
  <div class="bg-gray-900 border border-gray-800 rounded-2xl p-6">
    <h2 class="text-base font-semibold mb-5">Criar conta</h2>
    <div id="err" class="hidden bg-red-950 border border-red-800 text-red-300 text-sm px-4 py-2.5 rounded-xl mb-4"></div>
    <div id="ok" class="hidden bg-green-950 border border-green-800 text-green-300 text-sm px-4 py-2.5 rounded-xl mb-4"></div>
    <form id="form" class="space-y-4">
      <div>
        <label class="block text-xs text-gray-400 mb-1.5">Nome completo</label>
        <input id="name" type="text" required class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500 transition-colors" placeholder="Seu nome">
      </div>
      <div>
        <label class="block text-xs text-gray-400 mb-1.5">E-mail</label>
        <input id="email" type="email" required class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500 transition-colors" placeholder="seu@email.com">
      </div>
      <div>
        <label class="block text-xs text-gray-400 mb-1.5">WhatsApp</label>
        <input id="phone" type="tel" required class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500 transition-colors" placeholder="(11) 99999-9999">
      </div>
      <div>
        <label class="block text-xs text-gray-400 mb-1.5">Senha</label>
        <input id="pass" type="password" required minlength="6" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500 transition-colors" placeholder="Mínimo 6 caracteres">
      </div>
      <button type="submit" class="w-full bg-violet-600 hover:bg-violet-500 text-white font-medium py-2.5 rounded-xl transition-colors text-sm">
        Criar conta grátis
      </button>
    </form>
  </div>
  <p class="text-center text-xs text-gray-600 mt-4">Já tem conta? <a href="/login" class="text-violet-400 hover:text-violet-300">Entrar</a></p>
</div>
<script>
document.getElementById('form').onsubmit = async e => {
  e.preventDefault()
  const btn = e.target.querySelector('button')
  btn.disabled = true; btn.textContent = 'Criando conta...'
  const err = document.getElementById('err')
  const ok = document.getElementById('ok')
  err.classList.add('hidden'); ok.classList.add('hidden')
  const res = await fetch('/api/register', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      name: document.getElementById('name').value,
      email: document.getElementById('email').value,
      phone: document.getElementById('phone').value,
      password: document.getElementById('pass').value
    })
  })
  const d = await res.json()
  if (res.ok) {
    ok.textContent = 'Conta criada! Aguarde a liberação do acesso. Entraremos em contato pelo WhatsApp.'
    ok.classList.remove('hidden')
    e.target.reset()
    btn.textContent = 'Conta criada!'
  } else {
    err.textContent = d.error || 'Erro ao criar conta'
    err.classList.remove('hidden')
    btn.disabled = false; btn.textContent = 'Criar conta grátis'
  }
}
</script>
</body>
</html>`

// ── Admin panel ───────────────────────────────────────────────────────────────

function getAdminHTML(email) { return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZapVibe — Admin</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');*{font-family:'Inter',sans-serif}</style>
</head>
<body class="bg-gray-950 text-white min-h-screen">
<div class="max-w-5xl mx-auto px-4 py-8">

  <div class="flex items-center gap-3 mb-8">
    <div class="w-9 h-9 rounded-xl bg-violet-600 flex items-center justify-center text-lg">⚡</div>
    <div><h1 class="text-lg font-bold">ZapVibe</h1><p class="text-xs text-gray-500">Painel Admin</p></div>
    <div class="ml-auto flex items-center gap-3">
      <span class="text-xs text-gray-500">${email}</span>
      <a href="/app" class="text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors">Dashboard</a>
      <form method="POST" action="/logout"><button class="text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors">Sair</button></form>
    </div>
  </div>

  <div class="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
    <div class="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
      <div>
        <h2 class="font-semibold">Usuários</h2>
        <p class="text-xs text-gray-500 mt-0.5">Cadastros via landing page aparecem aqui como Pendente</p>
      </div>
      <button onclick="openAddUser()" class="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl transition-colors">+ Novo</button>
    </div>
    <div id="users-list" class="divide-y divide-gray-800">
      <p class="text-center py-8 text-gray-600 text-sm">Carregando...</p>
    </div>
  </div>
</div>

<!-- Add user modal -->
<div id="modal-add" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
  <div class="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-sm">
    <h3 class="font-semibold mb-4">Novo usuário</h3>
    <div id="add-err" class="hidden bg-red-950 border border-red-800 text-red-300 text-sm px-4 py-2 rounded-xl mb-3"></div>
    <form id="form-add" class="space-y-3">
      <div><label class="block text-xs text-gray-400 mb-1">E-mail</label>
        <input id="add-email" type="email" required class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500" placeholder="usuario@email.com"></div>
      <div><label class="block text-xs text-gray-400 mb-1">Senha inicial</label>
        <input id="add-pass" type="text" required class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500" placeholder="Senha temporária"></div>
      <div><label class="block text-xs text-gray-400 mb-1">Dias de acesso</label>
        <div class="flex gap-1.5 flex-wrap mb-1" id="days-btns">
          ${[7,15,30].map(d => `<button type="button" data-days="${d}" onclick="selectDays(${d})" class="days-opt px-3 py-1.5 text-xs rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors">${d} dias</button>`).join('')}
          <button type="button" data-days="custom" onclick="selectDays('custom')" class="days-opt px-3 py-1.5 text-xs rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors">Personalizado</button>
        </div>
        <input id="add-days-custom" type="number" min="1" class="hidden w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500" placeholder="Número de dias">
        <input id="add-days" type="hidden" value="7">
      </div>
      <div><label class="block text-xs text-gray-400 mb-1">Status</label>
        <select id="add-status" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-500">
          <option value="active">Ativo</option>
          <option value="pending">Pendente</option>
        </select></div>
      <div class="flex gap-2 pt-1">
        <button type="button" onclick="closeAddUser()" class="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 rounded-xl text-sm">Cancelar</button>
        <button type="submit" class="flex-1 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-xl text-sm font-medium">Criar</button>
      </div>
    </form>
  </div>
</div>

<!-- Set days modal -->
<div id="modal-days" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
  <div class="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-xs">
    <h3 class="font-semibold mb-1" id="days-modal-title">Definir dias de acesso</h3>
    <p id="days-modal-sub" class="text-xs text-gray-500 mb-4"></p>
    <div class="flex gap-1.5 flex-wrap mb-3">
      ${[7,15,30].map(d => `<button type="button" onclick="applyDays(${d})" class="px-3 py-1.5 text-xs rounded-lg bg-gray-800 hover:bg-violet-700 text-gray-300 transition-colors">${d} dias</button>`).join('')}
    </div>
    <div class="flex gap-2">
      <input id="days-custom-input" type="number" min="1" class="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500" placeholder="Personalizado">
      <button onclick="applyCustomDays()" class="px-3 py-2 bg-violet-600 hover:bg-violet-500 rounded-xl text-sm">OK</button>
    </div>
    <button onclick="closeDaysModal()" class="w-full mt-3 py-2 bg-gray-800 hover:bg-gray-700 rounded-xl text-sm text-gray-400">Cancelar</button>
  </div>
</div>

<script>
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
let daysTargetId = null

function trialLabel(u) {
  if (!u.trial_ends_at) return '<span class="text-gray-600">Sem trial</span>'
  const d = new Date(u.trial_ends_at)
  const days = Math.ceil((d - Date.now()) / 86400000)
  if (days < 0) return \`<span class="text-red-400">Expirado \${Math.abs(days)}d atrás</span>\`
  if (days === 0) return '<span class="text-amber-400">Expira hoje</span>'
  return \`<span class="text-green-400">\${days}d restantes</span>\`
}

async function loadUsers() {
  const res = await fetch('/api/admin/users')
  const users = await res.json()
  const el = document.getElementById('users-list')
  if (!users.length) { el.innerHTML = '<p class="text-center py-8 text-gray-600 text-sm">Nenhum usuário.</p>'; return }
  el.innerHTML = users.map(u => \`
    <div class="px-5 py-3.5 hover:bg-gray-800/40 transition-colors">
      <div class="flex items-start gap-3">
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium">\${esc(u.email)}</p>
          \${u.name ? \`<p class="text-xs text-gray-400">\${esc(u.name)} · \${esc(u.phone||'')}</p>\` : ''}
          <p class="text-xs text-gray-500 mt-0.5">Instância: \${esc(u.instance_name||'—')} · \${new Date(u.created_at).toLocaleDateString('pt-BR')}</p>
        </div>
        <div class="flex items-center gap-1.5 flex-wrap justify-end">
          <span class="text-xs">\${trialLabel(u)}</span>
          <button onclick="openDaysModal(\${u.id}, '\${esc(u.email)}')" class="text-xs px-2 py-1 bg-gray-800 hover:bg-violet-700/60 text-gray-300 rounded-lg transition-colors">⏱ Dias</button>
          <select onchange="setStatus(\${u.id},this.value)" class="text-xs bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 focus:outline-none">
            \${['pending','active','blocked'].map(s=>\`<option value="\${s}" \${u.status===s?'selected':''}>\${s==='pending'?'Pendente':s==='active'?'Ativo':'Bloqueado'}</option>\`).join('')}
          </select>
          \${u.role!=='admin'?\`<button onclick="deleteUser(\${u.id},'\${esc(u.email)}')" class="text-xs px-2 py-1 bg-red-950/60 hover:bg-red-900/60 text-red-400 rounded-lg">✕</button>\`:''}
        </div>
      </div>
    </div>\`).join('')
}

async function setStatus(id, status) {
  await fetch(\`/api/admin/users/\${id}\`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ status }) })
  loadUsers()
}

async function deleteUser(id, email) {
  if (!confirm('Excluir ' + email + '?')) return
  await fetch(\`/api/admin/users/\${id}\`, { method:'DELETE' })
  loadUsers()
}

function openDaysModal(id, email) {
  daysTargetId = id
  document.getElementById('days-modal-sub').textContent = email
  document.getElementById('modal-days').classList.remove('hidden')
  document.getElementById('days-custom-input').value = ''
}
function closeDaysModal() { document.getElementById('modal-days').classList.add('hidden'); daysTargetId = null }

async function applyDays(days) {
  await fetch(\`/api/admin/users/\${daysTargetId}\`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ trial_days: days, status: 'active' }) })
  closeDaysModal(); loadUsers()
}
async function applyCustomDays() {
  const v = parseInt(document.getElementById('days-custom-input').value)
  if (!v || v < 1) { alert('Informe um número válido'); return }
  await applyDays(v)
}

function selectDays(val) {
  document.querySelectorAll('.days-opt').forEach(b => b.classList.remove('bg-violet-700','text-white'))
  document.querySelectorAll('.days-opt').forEach(b => b.classList.add('bg-gray-800','text-gray-300'))
  const btn = document.querySelector(\`.days-opt[data-days="\${val}"]\`)
  if (btn) { btn.classList.remove('bg-gray-800','text-gray-300'); btn.classList.add('bg-violet-700','text-white') }
  const cInput = document.getElementById('add-days-custom')
  if (val === 'custom') { cInput.classList.remove('hidden'); document.getElementById('add-days').value = '' }
  else { cInput.classList.add('hidden'); document.getElementById('add-days').value = val }
}

function openAddUser() {
  document.getElementById('modal-add').classList.remove('hidden')
  selectDays(7)
}
function closeAddUser() { document.getElementById('modal-add').classList.add('hidden') }

document.getElementById('form-add').onsubmit = async e => {
  e.preventDefault()
  const btn = e.target.querySelector('[type=submit]')
  btn.disabled = true
  const errEl = document.getElementById('add-err')
  errEl.classList.add('hidden')
  let days = parseInt(document.getElementById('add-days').value) || parseInt(document.getElementById('add-days-custom').value) || 7
  const res = await fetch('/api/admin/users', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ email: document.getElementById('add-email').value, password: document.getElementById('add-pass').value, status: document.getElementById('add-status').value, trial_days: days })
  })
  const data = await res.json()
  if (res.ok) { closeAddUser(); loadUsers(); e.target.reset() }
  else { errEl.textContent = data.error || 'Erro ao criar usuário'; errEl.classList.remove('hidden') }
  btn.disabled = false
}

loadUsers()
</script>
</body>
</html>` }

// ── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = req.url
  const method = req.method

  const json = (data, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return }

  if (url === '/ping') {
    await db.ping().catch(() => {})
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return
  }

  // Register page
  if (url === '/register' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(REGISTER_HTML); return
  }

  if (url === '/api/register' && method === 'POST') {
    const body = await readBody(req)
    const name = (body.name || '').trim()
    const email = (body.email || '').toLowerCase().trim()
    const phone = (body.phone || '').trim()
    const password = body.password || ''
    if (!name || !email || !phone || !password) { json({ error: 'Preencha todos os campos' }, 400); return }
    if (password.length < 6) { json({ error: 'Senha mínima 6 caracteres' }, 400); return }
    const existing = await db.getUserByEmail(email)
    if (existing) { json({ error: 'E-mail já cadastrado' }, 409); return }
    const hash = await hashPassword(password)
    await db.registerUser(name, email, phone, hash)
    json({ ok: true }); return
  }

  // Login page
  if (url === '/login' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(LOGIN_HTML); return
  }

  if (url === '/login' && method === 'POST') {
    const body = await readBody(req)
    const user = await db.getUserByEmail((body.email || '').toLowerCase().trim())
    if (!user) { json({ error: 'E-mail ou senha inválidos' }, 401); return }
    const ok = await verifyPassword(body.password || '', user.password_hash)
    if (!ok) { json({ error: 'E-mail ou senha inválidos' }, 401); return }
    const token = generateToken()
    await db.createSession(token, user.email)
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`
    })
    res.end(JSON.stringify({ ok: true })); return
  }

  if (url === '/logout' && method === 'POST') {
    const cookies = parseCookies(req)
    if (cookies.session) await db.deleteSession(cookies.session)
    res.writeHead(302, {
      'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0',
      'Location': '/login'
    })
    res.end(); return
  }

  // Webhook — public, no auth (Evolution API calls this)
  if (url === '/webhook' && method === 'POST') {
    const body = await readBody(req)
    res.writeHead(200); res.end('ok')
    processWebhook(body).catch(console.error)
    return
  }

  // Public landing page
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(LANDING_HTML)
    return
  }

  // Auth guard — rotas abaixo exigem sessão válida
  const session = await getAuthSession(req)
  if (!session) {
    if (url.startsWith('/api/')) { json({ error: 'Não autorizado' }, 401); return }
    const next = encodeURIComponent(url)
    res.writeHead(302, { 'Location': `/login?next=${next}` }); res.end(); return
  }

  const authUser = await db.getUserByEmail(session.email)
  if (!authUser) {
    res.writeHead(302, { 'Location': '/login' }); res.end(); return
  }
  const trialExpired = authUser.trial_ends_at && new Date(authUser.trial_ends_at) < new Date()
  if (trialExpired && authUser.role !== 'admin') {
    if (url.startsWith('/api/')) { json({ error: 'Período de trial encerrado' }, 403); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>ZapVibe</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-950 text-white min-h-screen flex items-center justify-center"><div class="text-center max-w-sm mx-auto px-4"><div class="text-5xl mb-4">⏰</div><h1 class="text-xl font-bold mb-2">Trial encerrado</h1><p class="text-gray-400 mb-6">Seu período de teste expirou. Entre em contato para continuar usando.</p><a href="http://wa.link/k3gl1y" target="_blank" class="inline-block px-5 py-2.5 bg-green-600 hover:bg-green-500 text-white font-medium rounded-xl text-sm mb-3">💬 Falar com suporte</a><br><form method="POST" action="/logout"><button class="text-xs text-gray-500 hover:text-gray-300 mt-3">Sair</button></form></div></body></html>`)
    return
  }
  if (authUser.status !== 'active' && authUser.role !== 'admin') {
    if (url.startsWith('/api/')) { json({ error: 'Acesso pendente de aprovação' }, 403); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>ZapVibe</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-950 text-white min-h-screen flex items-center justify-center"><div class="text-center max-w-sm mx-auto px-4"><div class="text-5xl mb-4">⏳</div><h1 class="text-xl font-bold mb-2">Aguardando aprovação</h1><p class="text-gray-400 mb-2">Seu cadastro está sendo analisado.</p><p class="text-gray-500 text-sm mb-6">Assim que liberado você receberá acesso.</p><a href="http://wa.link/k3gl1y" target="_blank" class="inline-block px-5 py-2.5 bg-green-600 hover:bg-green-500 text-white font-medium rounded-xl text-sm mb-3">💬 Falar com suporte</a><br><form method="POST" action="/logout"><button class="text-xs text-gray-500 hover:text-gray-300 mt-3">Sair</button></form></div></body></html>`)
    return
  }

  const userId = authUser.id
  const userInstance = authUser.instance_name || INSTANCE
  const isAdmin = authUser.role === 'admin'

  // Admin panel
  if (url === '/admin' || url === '/admin/') {
    if (!isAdmin) { res.writeHead(302, { 'Location': '/app' }); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(getAdminHTML(authUser.email)); return
  }

  if (url === '/app' || url === '/app/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(getAppHTML(authUser.email, isAdmin, userInstance)); return
  }

  // Connection
  if (url === '/api/status') {
    try { json(await fetchApi(`/instance/connectionState/${userInstance}`, 'GET')) }
    catch (e) { json({ error: e.message }, 500) }
    return
  }

  if (url === '/api/connect' && method === 'POST') {
    try {
      const created = await fetchApi('/instance/create', 'POST', { instanceName: userInstance, qrcode: true, integration: 'WHATSAPP-BAILEYS' }).catch(e => ({ error: e.message }))
      console.log('[Connect] create:', JSON.stringify(created).slice(0, 300))
      let result = {}
      for (let i = 0; i < 6; i++) {
        await sleep(3000)
        result = await fetchApi(`/instance/connect/${userInstance}`, 'GET').catch(() => ({}))
        console.log(`[Connect] tentativa ${i+1}:`, JSON.stringify(result).slice(0, 200))
        if (result.qrcode?.base64 || result.base64) break
      }
      json(result)
    } catch (e) { json({ error: e.message }, 500) }
    return
  }

  if (url === '/api/disconnect' && method === 'POST') {
    try { json(await fetchApi(`/instance/logout/${userInstance}`, 'DELETE')) }
    catch (e) { json({ error: e.message }, 500) }
    return
  }

  // Contacts
  if (url === '/api/contacts' && method === 'GET') {
    json(await db.getContacts(userId)); return
  }

  if (url === '/api/contacts' && method === 'PUT') {
    const body = await readBody(req)
    await db.saveContacts(Array.isArray(body) ? body : [], userId)
    json({ ok: true }); return
  }

  if (url === '/api/contacts/import' && method === 'POST') {
    const body = await readBody(req)
    try {
      const csv = (body.csv || '').replace(/^﻿/, '') // remove BOM do Excel
      const firstLine = csv.split('\n')[0] || ''
      const delimiter = firstLine.includes(';') ? ';' : ','
      const rawRecords = parse(csv, { columns: true, skip_empty_lines: true, trim: true, delimiter, relax_column_count: true, bom: true })
      // Normaliza chaves para minúsculas e remove espaços
      const records = rawRecords.map(r => {
        const n = {}
        for (const k of Object.keys(r)) n[k.toLowerCase().trim().replace(/\s+/g,'')] = r[k]
        return n
      })
      const valid = [], invalid = []
      for (const r of records) {
        // Resolve notação científica do Excel (1,2E+10 ou 1.2E+10)
        let tel = String(r.telefone || '').trim().replace(',', '.')
        if (/e\+?\d+/i.test(tel)) tel = Math.round(parseFloat(tel)).toString()
        tel = tel.replace(/\D/g, '')
        if (!r.nome?.trim() || !tel) { invalid.push(r); continue }
        valid.push({ ...r, telefone: tel })
      }
      const existing = await db.getContacts(userId)
      const existingMap = new Map(existing.map(c => [c.telefone, c]))
      for (const c of valid) existingMap.set(c.telefone, c)
      const merged = [...existingMap.values()]
      await db.saveContacts(merged, userId)
      const invalidSamples = invalid.slice(0, 3).map(r => JSON.stringify(r).slice(0, 60))
      json({ ok: true, contacts: merged, imported: valid.length, invalid: invalid.length, invalidSamples })
    } catch (e) { json({ error: e.message }, 400) }
    return
  }

  // Auto-respostas
  if (url === '/api/autoreplies' && method === 'GET') {
    json(await db.getAutoreplies(userId)); return
  }

  if (url === '/api/autoreplies' && method === 'POST') {
    const body = await readBody(req)
    if (!body.name?.trim()) { json({ error: 'name obrigatório' }, 400); return }
    const rule = {
      id: Date.now().toString(),
      name: body.name.trim(),
      trigger: body.trigger || 'keywords',
      keywords: body.keywords || [],
      response: body.response || '',
      delay: body.delay || 1500,
      active: body.active !== false,
      mediaBase64: body.mediaBase64 || null,
      mediaMimetype: body.mediaMimetype || null,
      mediaFilename: body.mediaFilename || null,
      createdAt: new Date().toISOString()
    }
    await db.addAutoreply(rule, userId)
    json(rule); return
  }

  if (url.startsWith('/api/autoreplies/') && method === 'PUT') {
    const id = url.split('/')[3]
    const body = await readBody(req)
    await db.updateAutoreply(id, body, userId)
    json({ ok: true }); return
  }

  if (url.startsWith('/api/autoreplies/') && method === 'DELETE') {
    const id = url.split('/')[3]
    await db.deleteAutoreply(id, userId)
    json({ ok: true }); return
  }

  // Media
  if (url === '/api/media/upload' && method === 'POST') {
    const body = await readBody(req)
    if (!body.base64 || !body.mimetype || !body.filename) { json({ error: 'missing fields' }, 400); return }
    mediaStore.set(userId, { base64: body.base64, mimetype: body.mimetype, filename: body.filename, mediatype: detectMediatype(body.mimetype) })
    const m = mediaStore.get(userId)
    json({ ok: true, mediatype: m.mediatype, filename: m.filename }); return
  }

  if (url === '/api/media' && method === 'DELETE') {
    mediaStore.delete(userId); json({ ok: true }); return
  }

  if (url === '/api/media' && method === 'GET') {
    const m = mediaStore.get(userId)
    json(m ? { mediatype: m.mediatype, filename: m.filename, mimetype: m.mimetype } : null); return
  }

  // Template (rascunho atual)
  if (url === '/api/template' && method === 'GET') {
    const content = await db.getDraft(userId)
    json({ template: content || DEFAULT_TEMPLATE }); return
  }

  if (url === '/api/template' && method === 'PUT') {
    const body = await readBody(req)
    await db.saveDraft(body.template || '', userId)
    json({ ok: true }); return
  }

  // Templates salvos
  if (url === '/api/templates' && method === 'GET') {
    json(await db.getTemplates(userId)); return
  }

  if (url === '/api/templates' && method === 'POST') {
    const body = await readBody(req)
    if (!body.name?.trim() || !body.content?.trim()) { json({ error: 'name e content obrigatórios' }, 400); return }
    const tpl = { id: Date.now().toString(), name: body.name.trim(), content: body.content.trim(), createdAt: new Date().toISOString() }
    json(await db.addTemplate(tpl, userId)); return
  }

  if (url.startsWith('/api/templates/') && method === 'DELETE') {
    const id = url.split('/')[3]
    await db.deleteTemplate(id, userId)
    json({ ok: true }); return
  }

  if (url.startsWith('/api/templates/') && method === 'PUT') {
    const id = url.split('/')[3]
    const body = await readBody(req)
    await db.updateTemplate(id, { name: body.name?.trim(), content: body.content?.trim() }, userId)
    json({ ok: true }); return
  }

  // Campaign
  if (url === '/api/campaign/start' && method === 'POST') {
    const c_ = getCampaign(userId)
    if (c_.running) { json({ error: 'Campanha já em andamento' }, 400); return }
    const body = await readBody(req)
    const contacts = Array.isArray(body.contacts) && body.contacts.length ? body.contacts : await db.getContacts(userId)
    runCampaign(contacts, body.template, body.delayMin, body.delayMax, body.limit, body.useAI, body.useMedia ? mediaStore.get(userId) : null, body.templateId, body.templateName, userId, userInstance)
    json({ ok: true }); return
  }

  if (url === '/api/campaign/stop' && method === 'POST') {
    getCampaign(userId).stop = true; json({ ok: true }); return
  }

  if (url === '/api/campaign/progress') {
    const c_ = getCampaign(userId)
    json({ running: c_.running, total: c_.total, sent: c_.sent, failed: c_.failed, log: c_.log, results: c_.results })
    return
  }

  // Campaign history
  if (url === '/api/campaign/history' && method === 'GET') {
    json((await db.getCampaignLog(userId)).slice().reverse()); return
  }

  // Groups
  if (url === '/api/groups' && method === 'GET') {
    json(await db.getGroups(userId)); return
  }

  if (url === '/api/groups' && method === 'POST') {
    const body = await readBody(req)
    if (!body.name?.trim()) { json({ error: 'name obrigatório' }, 400); return }
    const group = { id: Date.now().toString(), name: body.name.trim(), phones: body.phones || [], createdAt: new Date().toISOString() }
    json(await db.addGroup(group, userId)); return
  }

  if (url.startsWith('/api/groups/') && method === 'PUT') {
    const id = url.split('/')[3]
    const body = await readBody(req)
    await db.updateGroup(id, body, userId)
    json({ ok: true }); return
  }

  if (url.startsWith('/api/groups/') && method === 'DELETE') {
    const id = url.split('/')[3]
    await db.deleteGroup(id, userId)
    json({ ok: true }); return
  }

  // Admin routes
  if (url.startsWith('/api/admin/') && !isAdmin) {
    json({ error: 'Acesso negado' }, 403); return
  }

  if (url === '/api/admin/users' && method === 'GET') {
    json(await db.getAllUsers()); return
  }

  if (url === '/api/admin/users' && method === 'POST') {
    const body = await readBody(req)
    const email = (body.email || '').toLowerCase().trim()
    if (!email || !body.password) { json({ error: 'email e password obrigatórios' }, 400); return }
    const existing = await db.getUserByEmail(email)
    if (existing) { json({ error: 'E-mail já cadastrado' }, 409); return }
    const hash = await hashPassword(body.password)
    const result = await db.upsertUser(email, hash, body.role || 'user', body.status || 'pending', null)
    const newUser = await db.getUserById(result.id)
    const instanceName = 'zv' + newUser.id
    const trialUpdates = { instance_name: instanceName }
    if (body.trial_days) {
      const d = new Date(); d.setDate(d.getDate() + parseInt(body.trial_days))
      trialUpdates.trial_ends_at = d.toISOString()
    }
    await db.updateUser(newUser.id, trialUpdates)
    json({ ok: true, id: newUser.id, email, instanceName }); return
  }

  if (url.startsWith('/api/admin/users/') && method === 'PUT') {
    const id = parseInt(url.split('/')[4])
    const body = await readBody(req)
    const updates = {}
    if (body.status !== undefined) updates.status = body.status
    if (body.role !== undefined) updates.role = body.role
    if (body.password) updates.password_hash = await hashPassword(body.password)
    if (body.trial_days !== undefined) {
      if (body.trial_days === 0 || body.trial_days === null) {
        updates.trial_ends_at = null
      } else {
        const d = new Date()
        d.setDate(d.getDate() + parseInt(body.trial_days))
        updates.trial_ends_at = d.toISOString()
      }
    }
    await db.updateUser(id, updates)
    if (body.status === 'active') {
      const u = await db.getUserById(id)
      if (u && u.instance_name) configureWebhookForInstance(u.instance_name).catch(() => {})
    }
    json({ ok: true }); return
  }

  if (url.startsWith('/api/admin/users/') && method === 'DELETE') {
    const id = parseInt(url.split('/')[4])
    await db.deleteUser(id)
    json({ ok: true }); return
  }

  res.writeHead(404); res.end('Not found')
})

async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'fabio.administradorl@gmail.com').toLowerCase()
  const password = process.env.ADMIN_PASSWORD
  if (!password) {
    console.log('⚠ ADMIN_PASSWORD não definido — defina a variável de ambiente')
    return
  }
  const hash = await hashPassword(password)
  const result = await db.upsertUser(email, hash, 'admin', 'active', null)
  if (result?.id) {
    const u = await db.getUserById(result.id)
    if (!u?.instance_name) {
      await db.updateUser(result.id, { instance_name: 'zv' + result.id }).catch(() => {})
    }
    await db.updateUser(result.id, { status: 'active' }).catch(() => {})
  }
  console.log(`✔ Admin configurado: ${email}`)
}

db.init().then(seedAdmin).then(() => {
  server.listen(PORT, () => {
    console.log(`\n⚡ ZapVibe Dashboard → http://localhost:${PORT}\n`)
    if (process.platform === 'win32') exec(`start "" "http://localhost:${PORT}"`)
    setTimeout(configureWebhook, 3000)
  })
}).catch(err => {
  console.error('Erro ao iniciar banco de dados:', err.message)
  process.exit(1)
})
