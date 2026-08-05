require('dotenv').config()
const http = require('http')
const { exec } = require('child_process')
const { parse } = require('csv-parse/sync')
const db = require('./db')
const { hashPassword, verifyPassword, generateToken, parseCookies, getAuthSession } = require('./auth')
const { applyTemplate, formatPhone, sleep, fetchApi, sendWhatsapp, sendWhatsappMedia, notifyAdminNewUser, detectMediatype, personalizeWithAI, INSTANCE } = require('./whatsapp')
const { campaigns, getCampaign, runCampaign } = require('./campaign')
const { processWebhook, configureWebhook, configureWebhookForInstance } = require('./webhook')
require('./crons')

// Compara telefone de um contato contra a lista de telefones de um grupo, aceitando
// variações de formato (com/sem DDI 55, com/sem 9º dígito).
function phoneInGroup(grp, telefone) {
  if (!grp || !Array.isArray(grp.phones)) return false
  const n = (telefone || '').replace(/\D/g, '')
  return grp.phones.some(p => {
    const gp = (p || '').replace(/\D/g, '')
    return gp === n || gp.endsWith(n) || n.endsWith(gp) || ('55' + gp) === n || gp === ('55' + n)
  })
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZapVibe — Login</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%231E1B4B'/><path d='M20 3L9 18h7l-4 11 14-16h-8z' fill='%238B5CF6'/></svg>">
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

const DEFAULT_TEMPLATE = `Ola, {nome}! Tudo bem?

Estou entrando em contato para apresentar o ZapVibe, nossa solucao de comunicacao via WhatsApp com inteligencia artificial.

Posso te mostrar como funciona em poucos minutos?`

const mediaStore = new Map()
const MEDIA_LIMITS = { image: 5*1024*1024, audio: 10*1024*1024, document: 10*1024*1024, video: 15*1024*1024 }


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
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%231E1B4B'/><path d='M20 3L9 18h7l-4 11 14-16h-8z' fill='%238B5CF6'/></svg>">
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
    <button onclick="tab('conn')" id="t-conn" class="tab tab-active flex-1 py-1.5 text-xs font-medium rounded-lg">📱 Conexão</button>
    <button onclick="tab('contacts')" id="t-contacts" class="tab flex-1 py-1.5 text-xs font-medium rounded-lg text-gray-400 hover:text-white">👥 Contatos</button>
    <button onclick="tab('campaign')" id="t-campaign" class="tab flex-1 py-1.5 text-xs font-medium rounded-lg text-gray-400 hover:text-white">📤 Campanha</button>
    <button onclick="tab('auto')" id="t-auto" class="tab flex-1 py-1.5 text-xs font-medium rounded-lg text-gray-400 hover:text-white">🤖 Respostas</button>
    <button onclick="tab('auto2')" id="t-auto2" class="tab flex-1 py-1.5 text-xs font-medium rounded-lg text-gray-400 hover:text-white">⚡ Automações</button>
    <button onclick="tab('hist')" id="t-hist" class="tab flex-1 py-1.5 text-xs font-medium rounded-lg text-gray-400 hover:text-white">📊 Histórico</button>
    <button onclick="tab('funnel')" id="t-funnel" class="tab flex-1 py-1.5 text-xs font-medium rounded-lg text-gray-400 hover:text-white">🎯 Funil</button>
  </div>

  <!-- ── TAB: Histórico ── -->
  <div id="p-hist" class="hidden fade space-y-4">
    <div class="flex items-center justify-between">
      <div>
        <p class="text-sm text-gray-400">Histórico de campanhas enviadas e controle anti-spam.</p>
      </div>
      <button onclick="loadHistory()" class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors">↻ Atualizar</button>
    </div>

    <!-- Pagamentos pendentes (comprovante manual) -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-4">
      <div class="flex items-center justify-between mb-3">
        <p class="text-xs text-gray-500 uppercase tracking-wider">💳 Pagamentos pendentes</p>
        <button onclick="loadPendingPayments()" class="text-xs text-gray-500 hover:text-gray-300">↻</button>
      </div>
      <div id="pending-payments-list" class="space-y-2">
        <p class="text-xs text-gray-600 text-center py-4">Carregando...</p>
      </div>
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

  <!-- ── TAB: Funil ── -->
  <div id="p-funnel" class="hidden fade space-y-4">
    <div class="flex items-center justify-between">
      <p class="text-sm text-gray-400">Funil visual — acompanhe seus leads e clientes por etapa. Arraste os cards entre as colunas.</p>
      <div class="flex gap-2 flex-shrink-0">
        <button onclick="openAddStageModal()" class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg whitespace-nowrap">+ Nova coluna</button>
        <button onclick="loadFunnel()" class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg">↻</button>
      </div>
    </div>
    <div id="funnel-board" class="flex gap-3 overflow-x-auto pb-4">
      <p class="text-xs text-gray-600">Carregando...</p>
    </div>
  </div>

  <!-- Funnel card modal -->
  <div id="funnel-card-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
    <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md space-y-3">
      <div class="flex items-center justify-between">
        <h3 id="funnel-card-modal-title" class="text-white font-semibold">Novo lead</h3>
        <button onclick="closeFunnelCardModal()" class="text-gray-500 hover:text-gray-300">✕</button>
      </div>
      <input id="fc-nome" placeholder="Nome *" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
      <input id="fc-telefone" placeholder="Telefone" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
      <input id="fc-empresa" placeholder="Empresa (opcional)" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
      <textarea id="fc-notes" rows="3" placeholder="Notas (opcional)" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500 resize-none"></textarea>
      <div class="flex gap-2">
        <button onclick="saveFunnelCard()" class="flex-1 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl">Salvar</button>
        <button id="fc-delete-btn" onclick="deleteFunnelCardConfirm()" class="hidden px-4 py-2 bg-red-700 hover:bg-red-600 text-white text-sm rounded-xl">Excluir</button>
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

  <!-- ── TAB: Automações ── -->
  <div id="p-auto2" class="hidden fade space-y-6">

    <!-- ── Vencimento Rules ── -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <div class="flex items-center justify-between mb-1">
        <div>
          <p class="text-sm font-semibold">📅 Automação por Vencimento</p>
          <p class="text-xs text-gray-500 mt-0.5">Envia mensagem automaticamente X dias antes do campo <span class="font-mono">vencimento</span> do contato</p>
        </div>
        <button onclick="openVencForm()" class="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium rounded-lg">+ Nova regra</button>
      </div>

      <!-- New rule form -->
      <div id="venc-form" class="hidden mt-4 bg-gray-800 rounded-xl p-4 space-y-3">
        <p class="text-xs font-semibold text-gray-300">Nova regra de vencimento</p>
        <input id="vf-name" placeholder="Nome da regra (ex: Aviso de renovação)" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
        <div class="flex gap-2">
          <div class="flex-1">
            <label class="text-xs text-gray-500 block mb-1">Dias antes do vencimento</label>
            <input id="vf-days" type="number" value="3" min="0" max="365" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
          </div>
          <div class="flex-1">
            <label class="text-xs text-gray-500 block mb-1">Grupo de contatos</label>
            <select id="vf-group" onchange="loadVfContactsPicker()" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500">
              <option value="">Todos os contatos</option>
            </select>
          </div>
        </div>
        <div>
          <label class="text-xs text-gray-500 block mb-1">Qual WhatsApp dispara essa regra</label>
          <select id="vf-instance" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500">
            <option value="">Padrão da conta</option>
          </select>
        </div>

        <div>
          <button type="button" onclick="toggleVfPicker()" class="w-full flex items-center justify-between bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm text-left">
            <span id="vf-picker-summary" class="text-gray-400">Enviar pra todo mundo do grupo (clique pra escolher pessoas específicas)</span>
            <span id="vf-picker-arrow" class="text-gray-500">▾</span>
          </button>
          <div id="vf-picker-panel" class="hidden mt-2 bg-gray-900 border border-gray-700 rounded-xl p-2 max-h-56 overflow-y-auto space-y-1">
            <p class="text-xs text-gray-600 text-center py-3">Carregando contatos...</p>
          </div>
        </div>

        <div>
          <label class="text-xs text-gray-500 block mb-1">Mensagem (use {nome}, {vencimento}, {empresa})</label>
          <textarea id="vf-content" rows="4" placeholder="Olá {nome}, seu serviço vence em {vencimento}. Renove agora!" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500 resize-none"></textarea>
        </div>
        <div class="flex gap-2">
          <button onclick="saveVencRule()" class="flex-1 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl">Salvar</button>
          <button onclick="closeVencForm()" class="flex-1 py-2 bg-gray-700 text-gray-300 text-sm rounded-xl">Cancelar</button>
        </div>
      </div>

      <div id="venc-list" class="mt-4 space-y-2">
        <p class="text-xs text-gray-600 text-center py-4">Nenhuma regra criada.</p>
      </div>
    </div>

    <!-- ── Drip Campaigns ── -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <div class="flex items-center justify-between mb-1">
        <div>
          <p class="text-sm font-semibold">🔁 Sequências (Drip)</p>
          <p class="text-xs text-gray-500 mt-0.5">Envie uma série de mensagens ao longo de dias para nutrir contatos</p>
        </div>
        <button onclick="openDripForm()" class="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium rounded-lg">+ Nova sequência</button>
      </div>

      <!-- Drip start modal -->
      <div id="drip-start-modal" class="hidden fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
        <div class="bg-gray-900 border border-gray-700 rounded-2xl p-5 w-full max-w-sm space-y-4">
          <p class="text-sm font-semibold">▶ Iniciar sequência</p>
          <div>
            <label class="block text-xs text-gray-400 mb-1.5">WhatsApp que vai enviar</label>
            <select id="drip-start-instance" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"></select>
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1.5">Enviar para</label>
            <select id="drip-start-group" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500">
              <option value="">Todos os contatos</option>
            </select>
          </div>
          <p class="text-xs text-gray-500">A 1ª mensagem entra na fila imediatamente e sai em até 1 minuto. As demais serão enviadas automaticamente nos dias configurados.</p>
          <div class="flex gap-2">
            <button onclick="confirmStartDrip()" class="flex-1 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl">Iniciar</button>
            <button onclick="closeDripStartModal()" class="flex-1 py-2 bg-gray-700 text-gray-300 text-sm rounded-xl">Cancelar</button>
          </div>
        </div>
      </div>

      <!-- New drip form -->
      <div id="drip-form" class="hidden mt-4 bg-gray-800 rounded-xl p-4 space-y-3">
        <p class="text-xs font-semibold text-gray-300">Nova sequência</p>
        <input id="df-name" placeholder="Nome da sequência (ex: Boas-vindas)" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
        <div id="df-steps" class="space-y-2"></div>
        <button onclick="addDripStep()" class="w-full py-2 border border-dashed border-gray-600 text-xs text-gray-500 hover:text-gray-300 hover:border-gray-500 rounded-xl">+ Adicionar etapa</button>
        <div class="flex gap-2">
          <button onclick="saveDrip()" class="flex-1 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl">Salvar</button>
          <button onclick="closeDripForm()" class="flex-1 py-2 bg-gray-700 text-gray-300 text-sm rounded-xl">Cancelar</button>
        </div>
      </div>

      <div id="drip-list" class="mt-4 space-y-2">
        <p class="text-xs text-gray-600 text-center py-4">Nenhuma sequência criada.</p>
      </div>
    </div>

    <!-- ── Scheduled Campaigns ── -->
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <div class="flex items-center justify-between mb-1">
        <div>
          <p class="text-sm font-semibold">🕐 Campanhas Agendadas</p>
          <p class="text-xs text-gray-500 mt-0.5">Campanhas que serão disparadas automaticamente no horário definido</p>
        </div>
      </div>
      <div id="sched-list" class="mt-4 space-y-2">
        <p id="sched-empty" class="text-xs text-gray-600 text-center py-4">Nenhuma campanha agendada.</p>
      </div>
    </div>

  </div>

  <!-- ── TAB: Conexão ── -->
  <div id="p-conn" class="fade">
    <!-- Header -->
    <div class="flex items-center justify-between mb-4">
      <div>
        <p class="text-sm text-gray-400">Gerencie suas contas WhatsApp conectadas.</p>
        <p id="inst-quota" class="text-xs text-gray-600 mt-0.5">Carregando...</p>
      </div>
      <button onclick="addInstance()" id="btn-add-inst" class="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl transition-colors hidden">+ Adicionar WhatsApp</button>
    </div>

    <!-- Instance list -->
    <div id="inst-list" class="space-y-3"></div>

    <!-- QR Modal -->
    <div id="qr-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 fade text-center">
        <p class="text-sm font-semibold mb-1" id="qr-modal-title">Conectar WhatsApp</p>
        <p class="text-xs text-gray-500 mb-4">Escaneie o QR Code com seu celular</p>
        <div id="qr-modal-content" class="flex justify-center mb-4">
          <div class="animate-pulse bg-gray-800 w-48 h-48 rounded-xl flex items-center justify-center">
            <span class="text-gray-600 text-xs">Gerando QR...</span>
          </div>
        </div>
        <p class="text-xs text-gray-600 mb-4">Celular → 3 pontos → Aparelhos conectados → Conectar</p>
        <button onclick="closeQrModal()" class="w-full py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-xl">Fechar</button>
      </div>
    </div>
  </div>

  <!-- Add WA Group Modal (fora das abas — funciona de qualquer aba) -->
  <div id="add-wa-group-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50">
    <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-md mx-4">
      <h3 class="text-white font-semibold mb-1">Adicionar grupo do WhatsApp</h3>
      <p class="text-xs text-gray-500 mb-4">Cole o link de convite OU o JID do grupo</p>
      <div class="mb-3">
        <label class="text-xs text-gray-400 mb-1 block">Link de convite <span class="text-gray-600">(https://chat.whatsapp.com/...)</span></label>
        <input id="add-wa-group-link" type="text" placeholder="https://chat.whatsapp.com/ABC123" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"/>
      </div>
      <div class="mb-3">
        <label class="text-xs text-gray-400 mb-1 block">JID direto <span class="text-gray-600">(alternativa — ex: 120363xxx@g.us)</span></label>
        <input id="add-wa-group-jid" type="text" placeholder="120363xxxxxxxxxx@g.us" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"/>
      </div>
      <div class="mb-3">
        <label class="text-xs text-gray-400 mb-1 block">Nome do grupo <span class="text-gray-600">(obrigatório se usar JID direto)</span></label>
        <input id="add-wa-group-name" type="text" placeholder="Nome do grupo" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"/>
      </div>
      <div class="mb-4">
        <label class="text-xs text-gray-400 mb-1 block">Instância WhatsApp</label>
        <select id="add-wa-group-instance" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"></select>
      </div>
      <div class="flex gap-2">
        <button onclick="addWaGroup()" class="flex-1 px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl transition-colors">Adicionar</button>
        <button onclick="document.getElementById('add-wa-group-modal').classList.add('hidden')" class="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-xl">Cancelar</button>
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
        <button onclick="openWebhookInfoModal()" class="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors">🔗 Importar automático (planilha)</button>
      </div>
      <div class="flex gap-2">
        <button id="btn-delete-selected" onclick="deleteSelected()" class="hidden px-4 py-2 bg-red-700 hover:bg-red-600 text-white text-sm font-medium rounded-xl transition-colors">🗑 Excluir selecionados</button>
        <button onclick="toggleAddForm()" class="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium rounded-xl transition-colors">+ Adicionar</button>
      </div>
    </div>

    <!-- Webhook auto-import modal -->
    <div id="webhook-info-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-lg space-y-4 max-h-[85vh] overflow-y-auto">
        <div class="flex items-center justify-between">
          <h3 class="text-white font-semibold">🔗 Importar automaticamente da planilha</h3>
          <button onclick="closeWebhookInfoModal()" class="text-gray-500 hover:text-gray-300">✕</button>
        </div>
        <p class="text-xs text-gray-400">Cole o script abaixo no Google Sheets (Extensões → Apps Script). A cada linha nova preenchida na planilha, o contato entra automaticamente no ZapVibe — sem precisar exportar/importar CSV de novo.</p>
        <div>
          <label class="text-xs text-gray-500 block mb-1">1. Sua URL de destino</label>
          <div class="flex gap-2">
            <input id="wh-url" readonly class="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-xs text-gray-300"/>
            <button onclick="copyWebhookField('wh-url')" class="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded-xl">Copiar</button>
          </div>
        </div>
        <div>
          <label class="text-xs text-gray-500 block mb-1">2. Seu token (mantenha em segredo)</label>
          <div class="flex gap-2">
            <input id="wh-token" readonly class="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-xs text-gray-300"/>
            <button onclick="copyWebhookField('wh-token')" class="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded-xl">Copiar</button>
          </div>
        </div>
        <div>
          <label class="text-xs text-gray-500 block mb-1">3. Script para colar no Apps Script da planilha</label>
          <p class="text-xs text-gray-500 mb-1.5">Sua planilha precisa ter as colunas, na primeira linha: <span class="font-mono text-gray-300">nome, telefone, empresa, extra, vencimento</span></p>
          <textarea id="wh-script" readonly rows="16" class="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2 text-[11px] font-mono text-gray-300 resize-none"></textarea>
          <button onclick="copyWebhookField('wh-script')" class="mt-2 w-full py-2 bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium rounded-xl">Copiar script</button>
        </div>
        <p class="text-xs text-gray-500">Depois de colar: no editor do Apps Script, clique no relógio (⏰ Gatilhos) → + Adicionar gatilho → escolha a função <span class="font-mono">aoEditarLinha</span> → evento "Ao editar" → Salvar. Pronto, a partir daí toda linha nova preenchida entra sozinha no ZapVibe.</p>
      </div>
    </div>

    <!-- Group diagnostic modal -->
    <div id="group-diag-modal" class="hidden fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div class="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-full max-w-lg space-y-3 max-h-[85vh] overflow-y-auto">
        <div class="flex items-center justify-between">
          <h3 id="group-diag-title" class="text-white font-semibold">🔍 Diagnóstico do grupo</h3>
          <button onclick="closeGroupDiagModal()" class="text-gray-500 hover:text-gray-300">✕</button>
        </div>
        <div id="group-diag-list" class="space-y-1.5"></div>
        <div id="group-diag-actions"></div>
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
        <input id="f-venc" placeholder="Vencimento (ex: 20/07/2026)" autocomplete="off" class="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
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
            <th class="text-left px-4 py-2">Vencimento</th>
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
      <!-- Instance selector -->
      <div class="mb-4 pb-4 border-b border-gray-800">
        <label class="text-xs text-gray-500 uppercase tracking-wider mb-2 block">Disparar de qual WhatsApp</label>
        <select id="camp-instance" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500">
          <option value="${userInstance}">📱 Principal (${userInstance})</option>
        </select>
      </div>
      <!-- WA Group mode toggle -->
      <div class="mb-4 pb-4 border-b border-gray-800">
        <label class="flex items-center gap-2 cursor-pointer mb-3">
          <input type="checkbox" id="wa-group-toggle" onchange="toggleWaGroupMode()" class="w-4 h-4 rounded accent-violet-600"/>
          <span class="text-xs text-gray-400">Enviar para grupo do WhatsApp</span>
        </label>
        <div id="wa-group-section" class="hidden">
          <div class="flex gap-2 items-center mb-2">
            <select id="wa-group-select" class="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500">
              <option value="">Nenhum grupo — clique em ＋ Adicionar</option>
            </select>
            <button onclick="syncAllWaGroups()" class="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded-xl whitespace-nowrap" title="Buscar todos os grupos da conta">🔄 Buscar</button>
            <button onclick="openAddWaGroupModal()" class="px-3 py-2 bg-violet-700 hover:bg-violet-600 text-white text-xs rounded-xl whitespace-nowrap">＋ Adicionar</button>
          </div>
        </div>
      </div>
      <!-- Group selector (contacts) -->
      <div id="camp-contacts-group-row" class="mb-4 pb-4 border-b border-gray-800">
        <label class="text-xs text-gray-500 uppercase tracking-wider mb-2 block">Grupo de contatos</label>
        <select id="camp-group" onchange="applyCampGroup()" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500">
          <option value="">📋 Todos os contatos</option>
        </select>
      </div>
      <div class="flex items-center justify-between mb-3">
        <div>
          <p class="text-xs text-gray-500 uppercase tracking-wider mb-1">Disparar campanha</p>
          <p id="camp-summary" class="text-sm text-gray-400">— contatos carregados</p>
        </div>
        <div class="flex gap-2">
          <button onclick="startCampaign()" id="btn-start" class="px-5 py-2.5 bg-violet-600 hover:bg-violet-500 text-white font-semibold rounded-xl transition-colors">▶ Disparar</button>
          <button onclick="stopCampaign()" id="btn-stop" class="hidden px-5 py-2.5 bg-red-700 hover:bg-red-600 text-white font-semibold rounded-xl transition-colors">⏹ Parar</button>
        </div>
      </div>
      <!-- Schedule toggle -->
      <div class="border-t border-gray-800 pt-3 mt-1">
        <label class="flex items-center gap-2 cursor-pointer mb-2">
          <input type="checkbox" id="sched-toggle" onchange="toggleSchedForm()" class="w-4 h-4 rounded accent-violet-600"/>
          <span class="text-xs text-gray-400">Agendar para depois</span>
        </label>
        <div id="sched-form" class="hidden flex gap-2 items-end">
          <div class="flex-1">
            <label class="text-xs text-gray-500 block mb-1">Data e hora</label>
            <input id="sched-dt" type="datetime-local" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
          </div>
          <button onclick="scheduleCampaign()" class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-xl whitespace-nowrap">📅 Agendar</button>
        </div>
        <p id="sched-selection-hint" class="text-xs text-gray-500 mt-2 hidden">
          Quer escolher pessoa por pessoa dentro do grupo? <button onclick="tab('contacts')" class="text-violet-400 hover:text-violet-300 underline">Abra a aba Contatos</button>, marque os que quiser e volte aqui — a seleção é aproveitada no agendamento.
        </p>
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

    <label class="text-xs text-gray-500 mb-1 block">WhatsApp</label>
    <select id="ar-instance" class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm mb-4 focus:outline-none focus:border-violet-500">
      <option value="">Todos os números</option>
    </select>

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

    <!-- Horário ativo -->
    <div class="border-t border-gray-700 pt-4 mt-2 space-y-3">
      <p class="text-xs font-semibold text-gray-300">⏰ Horário ativo</p>
      <div class="flex gap-1.5 flex-wrap">
        <button onclick="setSchedPreset('always')" id="sp-always" class="px-2.5 py-1 text-xs rounded-lg bg-violet-700 text-white">Sempre</button>
        <button onclick="setSchedPreset('weekdays')" id="sp-weekdays" class="px-2.5 py-1 text-xs rounded-lg bg-gray-700 text-gray-300">Dias úteis</button>
        <button onclick="setSchedPreset('weekend')" id="sp-weekend" class="px-2.5 py-1 text-xs rounded-lg bg-gray-700 text-gray-300">Fim de semana</button>
        <button onclick="setSchedPreset('custom')" id="sp-custom" class="px-2.5 py-1 text-xs rounded-lg bg-gray-700 text-gray-300">Personalizado</button>
      </div>
      <div id="sched-days-row" class="hidden flex gap-1">
        ${['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'].map((d,i) => `<button onclick="toggleSchedDay(${i})" id="sd-${i}" class="flex-1 py-1 text-xs rounded-lg bg-gray-700 text-gray-400">${d}</button>`).join('')}
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-gray-500 whitespace-nowrap">Das</label>
        <input id="ar-time-start" type="time" value="08:00" class="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-violet-500"/>
        <label class="text-xs text-gray-500">às</label>
        <input id="ar-time-end" type="time" value="18:00" class="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-violet-500"/>
        <label class="text-xs text-gray-600">(deixe iguais = sem limite)</label>
      </div>
      <div>
        <label class="text-xs text-gray-500 mb-1 block">Mensagem fora do horário (opcional)</label>
        <textarea id="ar-off-hours" rows="2" placeholder="Ex: Estamos fora do horário! Retornamos segunda das 8h às 18h."
          class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"></textarea>
      </div>
    </div>

    <!-- Seguimento automático -->
    <div class="border-t border-gray-700 pt-4 mt-2">
      <div class="flex items-center justify-between mb-2">
        <label class="text-xs text-gray-500">↩ Mensagens de seguimento (opcional)</label>
        <button onclick="addFollowupStep()" class="text-xs px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-violet-400 rounded-lg">+ Adicionar</button>
      </div>
      <div id="ar-followup-steps" class="space-y-2"></div>
      <p class="text-xs text-gray-600 mt-1">Enviadas automaticamente em horas após a resposta inicial.</p>
    </div>

    <div class="flex gap-2 mt-4">
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
    <p class="text-xs text-gray-500 mb-2">Escolha um grupo cadastrado no ZapVibe para incluir os contatos selecionados.</p>
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
      <input id="ec-venc" placeholder="Vencimento (ex: 20/07/2026)" autocomplete="off" class="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-violet-500"/>
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
      class="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm mb-3 focus:outline-none focus:border-violet-500"/>
    <div id="modal-media-info" class="hidden mb-3 flex items-center gap-2 bg-gray-800 rounded-xl px-3 py-2">
      <span id="modal-media-icon" class="text-lg"></span>
      <div class="flex-1 min-w-0">
        <p class="text-xs text-gray-300">Mídia anexada</p>
        <p id="modal-media-name" class="text-xs text-gray-500 truncate"></p>
      </div>
    </div>
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
let _currentMedia = null // { base64, mimetype, filename, mediatype } — mídia atual da seção de campanha

// ── Tabs ─────────────────────────────────────────────────────────────────────
function tab(id) {
  ['conn','contacts','campaign','auto','auto2','hist','funnel'].forEach(t => {
    document.getElementById('p-'+t).classList.add('hidden')
    document.getElementById('t-'+t).classList.remove('tab-active')
    document.getElementById('t-'+t).classList.add('text-gray-400')
  })
  document.getElementById('p-'+id).classList.remove('hidden')
  document.getElementById('t-'+id).classList.add('tab-active')
  document.getElementById('t-'+id).classList.remove('text-gray-400')
  if (id === 'conn') loadInstances()
  if (id === 'contacts') { loadContacts(); loadGroupsUI() }
  if (id === 'campaign') { loadTemplate(); updateCampSummary(); loadGroupsForCampaign(); loadInstances() }
  if (id === 'auto') { loadAutoList(); checkWebhookStatus() }
  if (id === 'auto2') { loadVencimentoRules(); loadDrips(); loadScheduledList() }
  if (id === 'hist') { loadHistory(); loadPendingPayments() }
  if (id === 'funnel') loadFunnel()
}

// ── Connection ────────────────────────────────────────────────────────────────
async function checkStatus() {
  try {
    const r = await fetch('/api/status').then(r=>r.json())
    const s = r?.instance?.state || 'close'
    document.getElementById('hd-dot').className = s==='open'?'w-2 h-2 rounded-full bg-green-500':'w-2 h-2 rounded-full bg-gray-600'
    document.getElementById('hd-txt').textContent = s==='open'?'Conectado':'Desconectado'
    return s
  } catch { return 'error' }
}

// ── Multi-instance connection tab ─────────────────────────────────────────────

async function loadInstances() {
  const [instances, me] = await Promise.all([
    fetch('/api/instances').then(r=>r.json()).catch(()=>[]),
    fetch('/api/me').then(r=>r.json()).catch(()=>({}))
  ])
  const maxInst = me.max_instances || 1
  const activeInstances = instances.filter(i => i.enabled !== false)
  const quota = document.getElementById('inst-quota')
  if (quota) quota.textContent = \`\${instances.length} de \${maxInst} instância\${maxInst!==1?'s':''} cadastrada\${maxInst!==1?'s':''} no seu plano · \${activeInstances.length} habilitada\${activeInstances.length!==1?'s':''}\`
  const addBtn = document.getElementById('btn-add-inst')
  if (addBtn) addBtn.classList.toggle('hidden', instances.length >= maxInst)

  // Populate campaign instance selector
  const campInst = document.getElementById('camp-instance')
  if (campInst) {
    campInst.innerHTML = activeInstances.length
      ? activeInstances.map(i => \`<option value="\${esc(i.instanceName)}">WA \${esc(i.label||i.instanceName)} (\${esc(i.instanceName)})</option>\`).join('')
      : '<option value="">Nenhum WhatsApp habilitado</option>'
  }

  const list = document.getElementById('inst-list')
  if (!list) return
  if (!instances.length) {
    list.innerHTML = '<p class="text-xs text-gray-600 text-center py-8">Nenhuma instância configurada.</p>'
    return
  }

  // Render each instance card, fetch status in parallel
  list.innerHTML = instances.map(inst => \`
    <div id="ic-\${inst.instanceName.replace(/[^a-z0-9]/gi,'_')}" class="bg-gray-900 border border-gray-800 rounded-2xl p-4 \${inst.enabled===false?'opacity-60':''}">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-3 min-w-0">
          <span class="w-3 h-3 rounded-full \${inst.enabled===false?'bg-amber-500':'bg-gray-600'} flex-shrink-0" id="dot-\${inst.instanceName.replace(/[^a-z0-9]/gi,'_')}"></span>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium" id="lbl-\${inst.instanceName.replace(/[^a-z0-9]/gi,'_')}">\${esc(inst.label||'WhatsApp')}</span>
              <button onclick="renameInstance('\${esc(inst.instanceName)}')" class="text-gray-600 hover:text-violet-400 text-xs">Editar</button>
              \${inst.enabled===false ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30">Desabilitado</span>' : ''}
            </div>
            <p class="text-xs font-mono text-gray-500">\${esc(inst.instanceName)}</p>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          <button onclick="toggleInstanceEnabled('\${esc(inst.instanceName)}', \${inst.enabled===false?'true':'false'})" class="px-3 py-1.5 \${inst.enabled===false?'bg-green-600 hover:bg-green-500 text-white':'bg-amber-600 hover:bg-amber-500 text-white'} text-xs font-medium rounded-lg transition-colors">\${inst.enabled===false?'Habilitar':'Desabilitar'}</button>
          <button onclick="connectInstance('\${esc(inst.instanceName)}')" class="px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium rounded-lg transition-colors">QR / Conectar</button>
          <button onclick="disconnectInstance('\${esc(inst.instanceName)}')" class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs rounded-lg transition-colors">Desconectar</button>
          \${instances.length > 1 ? \`<button onclick="removeInstance('\${esc(inst.instanceName)}')" class="text-gray-600 hover:text-red-400 text-xs px-1">X</button>\` : ''}
        </div>
      </div>
    </div>
  \`).join('')

  // Fetch status for each enabled instance
  for (const inst of instances) {
    const safeId = inst.instanceName.replace(/[^a-z0-9]/gi,'_')
    if (inst.enabled === false) continue
    fetch(\`/api/instances/\${encodeURIComponent(inst.instanceName)}/status\`)
      .then(r=>r.json())
      .then(r => {
        const state = r?.instance?.state || 'close'
        const dot = document.getElementById('dot-' + safeId)
        if (dot) dot.className = \`w-3 h-3 rounded-full flex-shrink-0 \${state==='open'?'bg-green-500 pulse-g':'bg-gray-600'}\`
      }).catch(()=>{})
  }
}

async function addInstance() {
  const label = prompt('Nome desta conta WhatsApp (ex: Vendas, Suporte, Marketing):')
  if (!label?.trim()) return
  const r = await fetch('/api/instances', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ label: label.trim() }) }).then(r=>r.json())
  if (r.error) { alert(r.error); return }
  loadInstances()
}

async function renameInstance(instanceName) {
  const safeId = instanceName.replace(/[^a-z0-9]/gi,'_')
  const cur = document.getElementById('lbl-' + safeId)?.textContent || ''
  const label = prompt('Novo nome para esta conta:', cur)
  if (!label?.trim() || label === cur) return
  await fetch(\`/api/instances/\${encodeURIComponent(instanceName)}\`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ label: label.trim() }) })
  loadInstances()
}

async function toggleInstanceEnabled(instanceName, enabled) {
  const action = enabled ? 'habilitar' : 'desabilitar'
  if (!confirm(\`Deseja \${action} esta conta WhatsApp?\`)) return
  const r = await fetch(\`/api/instances/\${encodeURIComponent(instanceName)}/enabled\`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ enabled })
  }).then(r=>r.json()).catch(e=>({ error: e.message }))
  if (r.error) { alert(r.error); return }
  loadInstances()
}
let _qrPollTimer = null
async function connectInstance(instanceName) {
  if (_qrPollTimer) { clearInterval(_qrPollTimer); _qrPollTimer = null }
  const modal = document.getElementById('qr-modal')
  const content = document.getElementById('qr-modal-content')
  const title = document.getElementById('qr-modal-title')
  if (title) title.textContent = \`Conectar: \${instanceName}\`
  content.innerHTML = '<div class="animate-pulse bg-gray-800 w-48 h-48 rounded-xl flex items-center justify-center"><span id="qr-load-txt" class="text-gray-600 text-xs">Iniciando...</span></div>'
  modal.classList.remove('hidden')
  await fetch(\`/api/instances/\${encodeURIComponent(instanceName)}/connect\`, {method:'POST'}).catch(()=>{})
  let hasQr = false, attempts = 0
  _qrPollTimer = setInterval(async () => {
    if (!document.getElementById('qr-modal') || modal.classList.contains('hidden')) {
      clearInterval(_qrPollTimer); _qrPollTimer = null; return
    }
    const st = await fetch(\`/api/instances/\${encodeURIComponent(instanceName)}/status\`).then(r=>r.json()).catch(()=>({}))
    if (st?.instance?.state === 'open') {
      clearInterval(_qrPollTimer); _qrPollTimer = null
      content.innerHTML = '<div class="flex flex-col items-center gap-3 py-8"><div class="text-5xl">✅</div><p class="text-green-400 font-semibold mt-2">WhatsApp conectado!</p></div>'
      setTimeout(() => { modal.classList.add('hidden'); loadInstances() }, 2000)
      return
    }
    attempts++
    if (attempts > 40) { clearInterval(_qrPollTimer); _qrPollTimer = null; return }
    const qr = await fetch(\`/api/instances/\${encodeURIComponent(instanceName)}/qr\`).then(r=>r.json()).catch(()=>({}))
    if (qr.base64) {
      hasQr = true
      content.innerHTML = \`<div class="bg-white p-3 rounded-xl"><img src="\${qr.base64}" class="w-48 h-48 object-contain"/></div>\`
    } else if (!hasQr) {
      const el = document.getElementById('qr-load-txt')
      if (el) el.textContent = \`Gerando QR\${'...'.slice(0, (attempts % 3) + 1)}\`
    }
  }, 3000)
}

function closeQrModal() {
  if (_qrPollTimer) { clearInterval(_qrPollTimer); _qrPollTimer = null }
  document.getElementById('qr-modal').classList.add('hidden')
  loadInstances()
}

async function disconnectInstance(instanceName) {
  if (!confirm(\`Desconectar \${instanceName}?\`)) return
  await fetch(\`/api/instances/\${encodeURIComponent(instanceName)}/disconnect\`, {method:'POST'})
  loadInstances()
}

async function removeInstance(instanceName) {
  if (!confirm(\`Remover a instância \${instanceName}? Isso a desconectará permanentemente.\`)) return
  const r = await fetch(\`/api/instances/\${encodeURIComponent(instanceName)}\`, {method:'DELETE'}).then(r=>r.json())
  if (r.error) { alert(r.error); return }
  loadInstances()
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
    if (activeGrp && !phoneInGroup(activeGrp, c.telefone)) return false
    if (grpFilter && !phoneInGroup(grpFilter, c.telefone)) return false
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
    const optoutBadge = c.optout ? \`<span class="inline-flex items-center gap-1 text-xs bg-red-950 text-red-400 border border-red-800/60 px-1.5 py-0.5 rounded-md ml-1">SAIU</span>\` : ''
    const optoutBtn = c.optout ? \`<button onclick="reincludeContact('\${esc(c.telefone)}')" title="Reincluir" class="text-red-600 hover:text-green-400 transition-colors text-xs">↩</button>\` : ''
    return \`
    <tr class="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors \${c.optout?'opacity-50':''\} \${chk?'bg-violet-950/20':''}">
      <td class="px-4 py-2.5"><input type="checkbox" \${chk?'checked':''} \${c.optout?'disabled':''} onchange="toggleContact(\${realIdx},this.checked)" class="accent-violet-600"/></td>
      <td class="px-4 py-2.5 font-medium">\${esc(c.nome)}\${optoutBadge}</td>
      <td class="px-4 py-2.5 font-mono text-gray-400 text-xs">\${esc(c.telefone)}</td>
      <td class="px-4 py-2.5 text-gray-400">\${esc(c.empresa||'—')}</td>
      <td class="px-4 py-2.5 text-gray-500 text-xs">\${esc(c.extra||'—')}</td>
      <td class="px-4 py-2.5 text-gray-400 text-xs">\${esc(c.vencimento||'—')}</td>
      <td class="px-4 py-2.5 text-right flex items-center justify-end gap-2">
        \${optoutBtn}
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
function phoneInGroup(grp, telefone) {
  if (!grp || !Array.isArray(grp.phones)) return false
  const n = (telefone || '').replace(/\D/g,'')
  return grp.phones.some(p => {
    const gp = (p || '').replace(/\D/g,'')
    return gp === n || gp.endsWith(n) || n.endsWith(gp) || ('55'+gp) === n || gp === ('55'+n)
  })
}

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
    extra: document.getElementById('f-ext').value.trim(),
    vencimento: document.getElementById('f-venc').value.trim()
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
      if (!phoneInGroup(grp, phone)) {
        grp.phones.push(phone)
        await fetch(\`/api/groups/\${groupId}\`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ phones: grp.phones }) })
      }
    }
  }

  document.getElementById('f-nome').value=''
  document.getElementById('f-tel').value=''
  document.getElementById('f-emp').value=''
  document.getElementById('f-ext').value=''
  document.getElementById('f-venc').value=''
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
  document.getElementById('ec-venc').value = c.vencimento || ''
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
    extra: document.getElementById('ec-ext').value.trim(),
    vencimento: document.getElementById('ec-venc').value.trim()
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

// ── Importação automática via planilha (Google Sheets → ZapVibe) ──────────────
function buildAppsScript(url, token) {
  return [
    "function aoEditarLinha(e) {",
    "  var ZAPVIBE_URL = '" + url + "';",
    "  var TOKEN = '" + token + "';",
    "",
    "  var range = e.range;",
    "  var sheet = range.getSheet();",
    "  var row = range.getRow();",
    "  if (row === 1) return; // ignora a linha de cabeçalho",
    "",
    "  var lastCol = sheet.getLastColumn();",
    "  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];",
    "  var values = sheet.getRange(row, 1, 1, lastCol).getValues()[0];",
    "",
    "  var data = {};",
    "  for (var i = 0; i < headers.length; i++) {",
    "    var key = headers[i].toString().trim().toLowerCase();",
    "    data[key] = values[i];",
    "  }",
    "  if (!data.telefone) return; // linha sem telefone, ignora",
    "",
    "  var payload = {",
    "    token: TOKEN,",
    "    nome: (data.nome || '').toString(),",
    "    telefone: data.telefone.toString(),",
    "    empresa: (data.empresa || '').toString(),",
    "    extra: (data.extra || '').toString(),",
    "    vencimento: (data.vencimento || '').toString()",
    "  };",
    "",
    "  UrlFetchApp.fetch(ZAPVIBE_URL, {",
    "    method: 'post',",
    "    contentType: 'application/json',",
    "    payload: JSON.stringify(payload),",
    "    muteHttpExceptions: true",
    "  });",
    "}"
  ].join('\\n')
}

async function openWebhookInfoModal() {
  document.getElementById('webhook-info-modal').classList.remove('hidden')
  const info = await fetch('/api/contacts/webhook-info').then(r=>r.json()).catch(()=>({}))
  document.getElementById('wh-url').value = info.url || ''
  document.getElementById('wh-token').value = info.token || ''
  document.getElementById('wh-script').value = buildAppsScript(info.url || '', info.token || '')
}

function closeWebhookInfoModal() {
  document.getElementById('webhook-info-modal').classList.add('hidden')
}

function copyWebhookField(id) {
  const el = document.getElementById(id)
  el.select()
  el.setSelectionRange(0, 999999)
  document.execCommand('copy')
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
  const mi = document.getElementById('modal-media-info')
  if (_currentMedia) {
    const icons = { image: '🖼', video: '🎥', audio: '🎵', document: '📄' }
    document.getElementById('modal-media-icon').textContent = icons[_currentMedia.mediatype] || '📎'
    document.getElementById('modal-media-name').textContent = _currentMedia.filename
    mi.classList.remove('hidden')
  } else {
    mi.classList.add('hidden')
  }
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
  const r = await fetch('/api/templates', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      name, content,
      media_data: _currentMedia?.base64 || null,
      media_type: _currentMedia?.mediatype || null,
      media_name: _currentMedia?.filename || null,
      media_mimetype: _currentMedia?.mimetype || null
    })
  }).then(r => r.json())
  if (r.error) { alert('Erro ao salvar: ' + r.error); return }
  closeSaveModal()
  await loadTemplateList()
}

async function loadTemplateList() {
  const list = await fetch('/api/templates').then(r => r.json())
  const el = document.getElementById('tpl-list')
  document.getElementById('tpl-count').textContent = list.length + ' template' + (list.length !== 1 ? 's' : '')
  if (!list.length) { el.innerHTML = '<p class="text-xs text-gray-600 text-center py-4">Nenhum template salvo ainda.</p>'; return }
  const mediaBadge = t => t.mediaType ? \`<span class="ml-1 text-xs px-1.5 py-0.5 bg-gray-700 text-gray-400 rounded">\${{image:'🖼',video:'🎥',audio:'🎵',document:'📄'}[t.mediaType]||'📎'}</span>\` : ''
  el.innerHTML = list.map(t => \`
    <div class="flex items-center gap-3 bg-gray-800 hover:bg-gray-750 border border-gray-700 rounded-xl px-4 py-3 group transition-colors">
      <div class="flex-1 min-w-0 cursor-pointer" onclick="loadSavedTemplate('\${t.id}')">
        <p class="text-sm font-medium text-white truncate">\${esc(t.name)}\${mediaBadge(t)}</p>
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
  const t = await fetch('/api/templates/' + id).then(r => r.json())
  if (!t || t.error) return
  document.getElementById('tpl').value = t.content
  window._activeTplId = t.id
  window._activeTplName = t.name
  if (t.mediaData && t.mediaType) {
    await fetch('/api/media/upload', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ base64: t.mediaData, mimetype: t.mediaMimetype, filename: t.mediaName })
    })
    _currentMedia = { base64: t.mediaData, mimetype: t.mediaMimetype, filename: t.mediaName, mediatype: t.mediaType }
    showMediaPreview(t.mediaType, t.mediaName, 'data:' + t.mediaMimetype + ';base64,' + t.mediaData)
  } else {
    await fetch('/api/media', { method: 'DELETE' })
    _currentMedia = null
    document.getElementById('media-placeholder').classList.remove('hidden')
    document.getElementById('media-preview').classList.add('hidden')
    document.getElementById('media-preview').classList.remove('flex')
    document.getElementById('media-badge').classList.add('hidden')
    document.getElementById('media-remove').classList.add('hidden')
    document.getElementById('prev-img').src = ''
    document.getElementById('prev-vid').src = ''
    document.getElementById('prev-aud').src = ''
  }
  document.getElementById('tpl').scrollIntoView({ behavior: 'smooth', block: 'center' })
  document.getElementById('tpl').focus()
}

async function updateSavedTemplate(id, currentName) {
  const content = document.getElementById('tpl').value.trim()
  if (!content) { alert('Editor está vazio. Carregue o template primeiro clicando em "Usar".'); return }
  const name = prompt('Nome do template:', currentName)
  if (name === null) return
  const r = await fetch('/api/templates/' + id, {
    method:'PUT', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      name: name || currentName,
      content,
      media_data: _currentMedia?.base64 || null,
      media_type: _currentMedia?.mediatype || null,
      media_name: _currentMedia?.filename || null,
      media_mimetype: _currentMedia?.mimetype || null
    })
  }).then(r => r.json())
  if (r.error) { alert('Erro ao atualizar: ' + r.error); return }
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
  if (window._remarketingContacts) {
    const rc = window._remarketingContacts
    document.getElementById('camp-summary').textContent = \`\${rc.length} contatos (remarketing)\`
    const btn = document.getElementById('btn-delete-selected')
    if (btn) btn.classList.add('hidden')
    const btnGrp = document.getElementById('btn-add-group')
    if (btnGrp) btnGrp.classList.add('hidden')
    return
  }
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
  const tpl = document.getElementById('tpl').value.trim()
  if (!tpl) { alert('Mensagem vazia.'); return }
  const selectedInstance = document.getElementById('camp-instance')?.value || ''

  // WA Group mode
  const waGroupMode = document.getElementById('wa-group-toggle')?.checked
  if (waGroupMode) {
    const groupJid = document.getElementById('wa-group-select')?.value
    if (!groupJid) { alert('Selecione um grupo do WhatsApp.'); return }
    const groupName = document.getElementById('wa-group-select')?.selectedOptions[0]?.text || groupJid
    if (!confirm(\`Enviar mensagem para o grupo "\${groupName}"?\`)) return
    const mediaInfo = await fetch('/api/media').then(r => r.json())
    const r = await fetch('/api/campaign/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupJid, groupName: document.getElementById('wa-group-select')?.selectedOptions[0]?.text || groupJid, template: tpl, useMedia: !!mediaInfo, instanceName: selectedInstance })
    }).then(r => r.json())
    if (r.error) { alert('Erro: ' + r.error); return }
    alert(\`✅ Mensagem enviada para o grupo!\`)
    return
  }

  const stateResp = selectedInstance
    ? await fetch('/api/instances/' + encodeURIComponent(selectedInstance) + '/status').then(r=>r.json()).catch(()=>({}))
    : { instance: { state: await checkStatus() } }
  const state = stateResp?.instance?.state || 'close'
  if (state !== 'open') { alert('WhatsApp selecionado não está conectado. Conecte primeiro na aba Conexão.'); return }
  if (!contacts.length) { alert('Nenhum contato. Adicione na aba Contatos.'); return }
  const remarketingContacts = window._remarketingContacts || null
  const targetContacts = remarketingContacts
    ? remarketingContacts
    : (selected.size > 0 ? contacts.filter((_,i) => selected.has(i)) : contacts)
  const limit = parseInt(document.getElementById('cfg-limit').value)
  const finalCount = Math.min(targetContacts.length, limit)
  const selLabel = remarketingContacts
    ? \`\${finalCount} contatos (remarketing)\`
    : selected.size > 0 ? \`\${selected.size} selecionados\` : 'todos os contatos'
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
      templateName: window._activeTplName || null,
      instanceName: selectedInstance
    })
  })
  if (remarketingContacts) clearRemarketing()

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
const _MEDIA_LIMITS = { image: 5, video: 15, audio: 10, document: 10 } // MB

async function uploadMedia(e) {
  const file = e.target.files[0]
  if (!file) return
  const mtype = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'document'
  const limitMB = _MEDIA_LIMITS[mtype]
  if (file.size > limitMB * 1024 * 1024) {
    alert(\`Arquivo muito grande. Limite para \${mtype}: \${limitMB}MB (este arquivo: \${(file.size/1024/1024).toFixed(1)}MB)\`)
    e.target.value = ''; return
  }
  const reader = new FileReader()
  reader.onload = async ev => {
    const dataUrl = ev.target.result
    const base64 = dataUrl.split(',')[1]
    const r = await fetch('/api/media/upload', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ base64, mimetype: file.type, filename: file.name })
    }).then(r => r.json())
    _currentMedia = { base64, mimetype: file.type, filename: file.name, mediatype: r.mediatype }
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
  _currentMedia = null
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

let _schedDays = null // null = always, array = specific days
let _followupSteps = [] // [{ delayHours, message }]

function setSchedPreset(preset) {
  ['always','weekdays','weekend','custom'].forEach(p => {
    const el = document.getElementById('sp-' + p)
    const active = p === preset
    el.classList.toggle('bg-violet-700', active)
    el.classList.toggle('text-white', active)
    el.classList.toggle('bg-gray-700', !active)
    el.classList.toggle('text-gray-300', !active)
  })
  document.getElementById('sched-days-row').classList.toggle('hidden', preset !== 'custom')
  const timeRow = document.getElementById('ar-time-start')?.closest('div')
  if (preset === 'always') {
    _schedDays = null
    document.getElementById('ar-time-start').value = '00:00'
    document.getElementById('ar-time-end').value = '00:00'
  }
  else if (preset === 'weekdays') { _schedDays = [1,2,3,4,5]; updateDayBtns() }
  else if (preset === 'weekend') { _schedDays = [0,6]; updateDayBtns() }
  else if (preset === 'custom') { if (!_schedDays) { _schedDays = [1,2,3,4,5]; updateDayBtns() } }
}

function toggleSchedDay(i) {
  if (!_schedDays) _schedDays = []
  const idx = _schedDays.indexOf(i)
  if (idx >= 0) _schedDays.splice(idx, 1); else _schedDays.push(i)
  updateDayBtns()
}

function updateDayBtns() {
  [0,1,2,3,4,5,6].forEach(i => {
    const btn = document.getElementById('sd-' + i)
    if (!btn) return
    const on = _schedDays?.includes(i)
    btn.className = btn.className.replace(/bg-\S+\s?text-\S+/, '')
    btn.classList.add(on ? 'bg-violet-700' : 'bg-gray-700', on ? 'text-white' : 'text-gray-400')
  })
}

function openAutoModal(rule) {
  arMediaData = null
  _schedDays = rule?.activeDays || null
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
  // Schedule
  document.getElementById('ar-time-start').value = rule?.activeStart || '08:00'
  document.getElementById('ar-time-end').value = rule?.activeEnd || '18:00'
  document.getElementById('ar-off-hours').value = rule?.offHoursMsg || ''
  const preset = !rule?.activeDays ? 'always' : JSON.stringify(rule.activeDays) === '[1,2,3,4,5]' ? 'weekdays' : JSON.stringify(rule.activeDays) === '[0,6]' ? 'weekend' : 'custom'
  setSchedPreset(preset)
  updateDayBtns()
  // Instances
  fetch('/api/instances').then(r=>r.json()).then(instances => {
    const sel = document.getElementById('ar-instance')
    const enabledInstances = instances.filter(i => i.enabled !== false)
    sel.innerHTML = '<option value="">Todos os números habilitados</option>' +
      enabledInstances.map(i => \`<option value="\${i.instanceName}">\${esc(i.label || i.instanceName)} (\${esc(i.instanceName)})</option>\`).join('')
    sel.value = enabledInstances.some(i => i.instanceName === rule?.instanceName) ? rule.instanceName : ''
  })
  // Templates
  fetch('/api/templates').then(r=>r.json()).then(templates => {
    const sel = document.getElementById('ar-template')
    sel.innerHTML = '<option value="">Todas as campanhas (global)</option>' +
      templates.map(t => '<option value="' + t.id + '">' + esc(t.name) + '</option>').join('')
    sel.value = rule?.templateId || ''
  })
  // Follow-up steps
  _followupSteps = rule?.followupSteps ? [...rule.followupSteps] : []
  renderFollowupSteps()
  document.getElementById('auto-modal').classList.remove('hidden')
}

function closeAutoModal() {
  document.getElementById('auto-modal').classList.add('hidden')
  arMediaData = null
  _followupSteps = []
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
  const timeStart = document.getElementById('ar-time-start').value
  const timeEnd = document.getElementById('ar-time-end').value
  const hasTimeRange = _schedDays !== null && timeStart && timeEnd && timeStart !== timeEnd
  const validFollowups = _followupSteps.filter(s => s.message.trim() && s.delayHours > 0)
  const instSel = document.getElementById('ar-instance')
  const payload = {
    name, trigger, keywords,
    instanceName: instSel.value || null,
    templateId, templateName,
    response: document.getElementById('ar-response').value,
    delay: parseInt(document.getElementById('ar-delay').value) || 2000,
    active: document.getElementById('ar-active').checked,
    mediaBase64: arMediaData?.base64 || null,
    mediaMimetype: arMediaData?.mimetype || null,
    mediaFilename: arMediaData?.filename || null,
    activeDays: _schedDays,
    activeStart: hasTimeRange ? timeStart : null,
    activeEnd: hasTimeRange ? timeEnd : null,
    offHoursMsg: document.getElementById('ar-off-hours').value.trim() || null,
    followupSteps: validFollowups
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
    const [statusR, reconfR] = await Promise.all([
      fetch('/api/status').then(r=>r.json()),
      fetch('/api/reconfigure-webhooks', {method:'POST'}).then(r=>r.json()).catch(()=>({}))
    ])
    const connected = statusR?.instance?.state === 'open'
    const el = document.getElementById('webhook-status')
    el.textContent = connected
      ? '✔ Webhook ativo — respostas automáticas funcionando'
      : '⚠ WhatsApp desconectado — conecte na aba Conexão'
    el.className = connected ? 'text-xs text-green-500 mt-0.5' : 'text-xs text-amber-500 mt-0.5'
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
      <button onclick="diagnosticarGrupo('\${g.id}')" title="Diagnosticar" class="text-gray-600 hover:text-amber-400 text-xs transition-colors">🔍</button>
      <button onclick="deleteGroup('\${g.id}')" class="text-gray-600 hover:text-red-400 text-xs transition-colors">✕</button>
    </span>\`).join('')
  el.innerHTML = allBtn + chips
}

function diagnosticarGrupo(id) {
  const grp = groups.find(g => g.id === id)
  if (!grp) return
  document.getElementById('group-diag-title').textContent = \`🔍 Diagnóstico: \${grp.name}\`
  const rows = grp.phones.map(p => {
    const match = contacts.find(c => {
      const cn = c.telefone.replace(/\D/g,'')
      const gp = (p || '').replace(/\D/g,'')
      return gp === cn || gp.endsWith(cn) || cn.endsWith(gp) || ('55'+gp) === cn || gp === ('55'+cn)
    })
    return { phone: p, match }
  })
  const orphans = rows.filter(r => !r.match)
  const listEl = document.getElementById('group-diag-list')
  listEl.innerHTML = rows.map(r => \`
    <div class="flex items-center justify-between bg-gray-800 rounded-lg px-3 py-2 text-xs">
      <span class="\${r.match ? 'text-gray-300' : 'text-red-400'}">\${esc(r.phone)}</span>
      <span class="\${r.match ? 'text-emerald-400' : 'text-red-400'}">\${r.match ? '✓ ' + esc(r.match.nome) : '✕ nenhum contato encontrado'}</span>
    </div>
  \`).join('')
  const actionsEl = document.getElementById('group-diag-actions')
  actionsEl.innerHTML = orphans.length
    ? \`<button onclick="limparOrfaosGrupo('\${id}')" class="w-full py-2 bg-red-700 hover:bg-red-600 text-white text-xs font-medium rounded-xl">Remover \${orphans.length} número(s) órfão(s) do grupo</button>\`
    : '<p class="text-xs text-emerald-400 text-center">Todos os números do grupo batem com contatos existentes ✓</p>'
  document.getElementById('group-diag-modal').classList.remove('hidden')
}

function closeGroupDiagModal() {
  document.getElementById('group-diag-modal').classList.add('hidden')
}

async function limparOrfaosGrupo(id) {
  const grp = groups.find(g => g.id === id)
  if (!grp) return
  if (!confirm('Remover os números órfãos desse grupo? Essa ação não pode ser desfeita.')) return
  const validPhones = grp.phones.filter(p => contacts.some(c => {
    const cn = c.telefone.replace(/\D/g,'')
    const gp = (p || '').replace(/\D/g,'')
    return gp === cn || gp.endsWith(cn) || cn.endsWith(gp) || ('55'+gp) === cn || gp === ('55'+cn)
  }))
  await fetch(\`/api/groups/\${id}\`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ phones: validPhones }) })
  grp.phones = validPhones
  closeGroupDiagModal()
  renderGroupChips()
  filterContacts()
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
  if (window._remarketingContacts) {
    sel.innerHTML = \`<option value="__remarketing__">↩ Remarketing: \${window._remarketingContacts.length} contatos selecionados</option>\`
    sel.disabled = true
    sel.style.borderColor = 'rgb(180 83 9 / 0.6)'
    sel.style.color = '#fbbf24'
  }
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
      if (phoneInGroup(grp, phone)) selected.add(i)
    })
  }
  updateCampSummary()
  renderContacts()
}


// ── WA Groups ─────────────────────────────────────────────────────────────────
async function syncAllWaGroups() {
  const instanceName = document.getElementById('camp-instance')?.value || ''
  const btn = event?.target
  if (btn) { btn.disabled = true; btn.textContent = '⏳...' }
  try {
    const r = await fetch(\`/api/wa-groups/sync?instance=\${encodeURIComponent(instanceName)}\`, { method: 'POST' }).then(r => r.json())
    if (r.count > 0) {
      await loadWaGroups()
      alert(\`✅ \${r.count} grupo(s) encontrado(s)!\`)
    } else {
      alert('Nenhum grupo encontrado via API. Use ＋ Adicionar com o link de convite ou JID do grupo.')
    }
  } catch(e) {
    alert('Erro: ' + e.message)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Buscar' }
  }
}

async function loadWaGroups() {
  const instanceName = document.getElementById('camp-instance')?.value || ''
  const sel = document.getElementById('wa-group-select')
  if (!sel) return
  const groups = await fetch(\`/api/wa-groups?instance=\${encodeURIComponent(instanceName)}\`).then(r => r.json()).catch(() => [])
  sel.innerHTML = groups.length
    ? groups.map(g => \`<option value="\${esc(g.jid)}">\${esc(g.name)}</option>\`).join('')
    : '<option value="">Nenhum grupo — clique em ＋ Adicionar</option>'
}

function toggleWaGroupMode() {
  const on = document.getElementById('wa-group-toggle')?.checked
  document.getElementById('wa-group-section')?.classList.toggle('hidden', !on)
  document.getElementById('camp-contacts-group-row')?.classList.toggle('hidden', on)
  if (on) {
    const summary = document.getElementById('camp-summary')
    if (summary) summary.textContent = '1 mensagem para o grupo'
    loadWaGroups()
  } else {
    updateCampSummary()
  }
}

function openAddWaGroupModal() {
  const instSel = document.getElementById('add-wa-group-instance')
  const campInst = document.getElementById('camp-instance')
  if (instSel && campInst) instSel.innerHTML = campInst.innerHTML
  document.getElementById('add-wa-group-link').value = ''
  document.getElementById('add-wa-group-jid').value = ''
  document.getElementById('add-wa-group-name').value = ''
  document.getElementById('add-wa-group-modal').classList.remove('hidden')
}

async function addWaGroup() {
  const link = document.getElementById('add-wa-group-link').value.trim()
  const jid = document.getElementById('add-wa-group-jid').value.trim()
  const name = document.getElementById('add-wa-group-name').value.trim()
  const instanceName = document.getElementById('add-wa-group-instance').value
  if (!link && !jid) { alert('Informe o link de convite OU o JID do grupo.'); return }
  const btn = event?.target
  if (btn) { btn.disabled = true; btn.textContent = 'Adicionando...' }
  try {
    const r = await fetch('/api/wa-groups/add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteLink: link, jid, name, instanceName })
    }).then(r => r.json())
    if (r.error) { alert('Erro: ' + r.error); return }
    alert(\`✅ Grupo "\${r.name}" adicionado!\`)
    document.getElementById('add-wa-group-modal').classList.add('hidden')
    await loadWaGroups()
  } catch (e) {
    alert('Erro: ' + e.message)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Adicionar' }
  }
}

// ── Funil visual (Kanban) ──────────────────────────────────────────────────────
let funnelStages = []
let funnelCards = []
let funnelEditingCardId = null
let funnelAddStageId = null
let funnelDraggingCardId = null

async function loadFunnel() {
  const [stages, cards] = await Promise.all([
    fetch('/api/funnel/stages').then(r=>r.json()).catch(()=>[]),
    fetch('/api/funnel/cards').then(r=>r.json()).catch(()=>[])
  ])
  funnelStages = stages
  funnelCards = cards
  renderFunnel()
}

function renderFunnel() {
  const board = document.getElementById('funnel-board')
  if (!funnelStages.length) { board.innerHTML = '<p class="text-xs text-gray-600">Nenhuma coluna ainda.</p>'; return }
  board.innerHTML = funnelStages.map(s => {
    const cards = funnelCards.filter(c => c.stageId === s.id).sort((a,b) => a.position - b.position)
    return \`
    <div class="flex-shrink-0 w-64 bg-gray-900 border border-gray-800 rounded-2xl flex flex-col max-h-[70vh]" ondragover="event.preventDefault()" ondrop="onFunnelDrop(event, '\${s.id}')">
      <div class="flex items-center justify-between px-3 py-2.5 border-b border-gray-800 gap-1">
        <input value="\${esc(s.name)}" onchange="renameFunnelStage('\${s.id}', this.value)" class="bg-transparent text-xs font-semibold text-gray-300 outline-none w-32 truncate"/>
        <div class="flex items-center gap-1.5 flex-shrink-0">
          <span class="text-xs text-gray-600">\${cards.length}</span>
          <button onclick="deleteFunnelStageConfirm('\${s.id}')" class="text-gray-600 hover:text-red-400 text-xs">✕</button>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto p-2 space-y-2">
        \${cards.map(c => \`
          <div draggable="true" ondragstart="onFunnelDragStart(event, '\${c.id}')" onclick="openEditCardModal('\${c.id}')" class="bg-gray-800 hover:bg-gray-700 rounded-xl p-2.5 cursor-grab">
            <p class="text-xs font-medium">\${esc(c.nome)}</p>
            \${c.telefone ? \`<p class="text-xs text-gray-500">\${esc(c.telefone)}</p>\` : ''}
            \${c.empresa ? \`<p class="text-xs text-gray-600">\${esc(c.empresa)}</p>\` : ''}
          </div>
        \`).join('')}
      </div>
      <button onclick="openAddCardModal('\${s.id}')" class="text-xs text-gray-500 hover:text-gray-300 px-3 py-2 border-t border-gray-800">+ Adicionar</button>
    </div>\`
  }).join('') + \`
    <div class="flex-shrink-0 w-64">
      <button onclick="openAddStageModal()" class="w-full h-12 border-2 border-dashed border-gray-800 hover:border-gray-700 rounded-2xl text-xs text-gray-600 hover:text-gray-400">+ Nova coluna</button>
    </div>\`
}

function onFunnelDragStart(e, cardId) {
  funnelDraggingCardId = cardId
  e.dataTransfer.effectAllowed = 'move'
}

async function onFunnelDrop(e, stageId) {
  e.preventDefault()
  if (!funnelDraggingCardId) return
  const cardId = funnelDraggingCardId
  funnelDraggingCardId = null
  const card = funnelCards.find(c => c.id === cardId)
  if (!card || card.stageId === stageId) return
  card.stageId = stageId
  renderFunnel()
  await fetch(\`/api/funnel/cards/\${cardId}\`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ stageId }) })
}

async function renameFunnelStage(id, name) {
  if (!name.trim()) return
  await fetch(\`/api/funnel/stages/\${id}\`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: name.trim() }) })
  const s = funnelStages.find(s => s.id === id); if (s) s.name = name.trim()
}

async function deleteFunnelStageConfirm(id) {
  const cardsHere = funnelCards.filter(c => c.stageId === id)
  const msg = cardsHere.length
    ? \`Excluir essa coluna? Os \${cardsHere.length} card(s) dela vão pra primeira coluna.\`
    : 'Excluir essa coluna?'
  if (!confirm(msg)) return
  await fetch(\`/api/funnel/stages/\${id}\`, { method:'DELETE' })
  loadFunnel()
}

async function openAddStageModal() {
  const name = prompt('Nome da nova coluna:')
  if (!name || !name.trim()) return
  await fetch('/api/funnel/stages', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: name.trim() }) })
  loadFunnel()
}

function openAddCardModal(stageId) {
  funnelEditingCardId = null
  funnelAddStageId = stageId
  document.getElementById('funnel-card-modal-title').textContent = 'Novo lead'
  document.getElementById('fc-nome').value = ''
  document.getElementById('fc-telefone').value = ''
  document.getElementById('fc-empresa').value = ''
  document.getElementById('fc-notes').value = ''
  document.getElementById('fc-delete-btn').classList.add('hidden')
  document.getElementById('funnel-card-modal').classList.remove('hidden')
}

function openEditCardModal(id) {
  const c = funnelCards.find(x => x.id === id)
  if (!c) return
  funnelEditingCardId = id
  document.getElementById('funnel-card-modal-title').textContent = 'Editar lead'
  document.getElementById('fc-nome').value = c.nome || ''
  document.getElementById('fc-telefone').value = c.telefone || ''
  document.getElementById('fc-empresa').value = c.empresa || ''
  document.getElementById('fc-notes').value = c.notes || ''
  document.getElementById('fc-delete-btn').classList.remove('hidden')
  document.getElementById('funnel-card-modal').classList.remove('hidden')
}

function closeFunnelCardModal() {
  document.getElementById('funnel-card-modal').classList.add('hidden')
}

async function saveFunnelCard() {
  const nome = document.getElementById('fc-nome').value.trim()
  const telefone = document.getElementById('fc-telefone').value.trim()
  const empresa = document.getElementById('fc-empresa').value.trim()
  const notes = document.getElementById('fc-notes').value.trim()
  if (!nome) { alert('Nome obrigatório'); return }
  if (funnelEditingCardId) {
    await fetch(\`/api/funnel/cards/\${funnelEditingCardId}\`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ nome, telefone, empresa, notes }) })
  } else {
    await fetch('/api/funnel/cards', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ nome, telefone, empresa, notes, stageId: funnelAddStageId }) })
  }
  closeFunnelCardModal()
  loadFunnel()
}

async function deleteFunnelCardConfirm() {
  if (!funnelEditingCardId) return
  if (!confirm('Excluir esse lead do funil?')) return
  await fetch(\`/api/funnel/cards/\${funnelEditingCardId}\`, { method:'DELETE' })
  closeFunnelCardModal()
  loadFunnel()
}

// ── Histórico ─────────────────────────────────────────────────────────────────
let pendingPaymentsCache = []
let pendingPaymentsContactsCache = []

function openComprovanteInNewTab(id) {
  const p = pendingPaymentsCache.find(x => x.id === id)
  if (!p) return
  const byteChars = atob(p.imageBase64)
  const byteNumbers = new Array(byteChars.length)
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i)
  const byteArray = new Uint8Array(byteNumbers)
  const blob = new Blob([byteArray], { type: p.mimetype })
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank')
}

async function loadPendingPayments() {
  const [list, cts] = await Promise.all([
    fetch('/api/pending-payments').then(r=>r.json()).catch(()=>[]),
    fetch('/api/contacts').then(r=>r.json()).catch(()=>[])
  ])
  pendingPaymentsCache = list
  pendingPaymentsContactsCache = cts
  const el = document.getElementById('pending-payments-list')
  if (!list.length) { el.innerHTML = '<p class="text-xs text-gray-600 text-center py-4">Nenhum comprovante aguardando confirmação.</p>'; return }
  el.innerHTML = list.map(p => {
    const when = new Date(p.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    const isPdf = p.mimetype === 'application/pdf'
    const preview = isPdf
      ? \`<div onclick="openComprovanteInNewTab('\${p.id}')" class="w-16 h-16 flex items-center justify-center bg-gray-700 rounded-lg cursor-pointer flex-shrink-0 text-2xl">📄</div>\`
      : \`<img src="data:\${p.mimetype};base64,\${p.imageBase64}" class="w-16 h-16 object-cover rounded-lg cursor-pointer flex-shrink-0" onclick="openComprovanteInNewTab('\${p.id}')"/>\`
    const unidentified = !p.telefone
    const linkPicker = unidentified
      ? \`<div class="mt-2">
          <p class="text-xs text-amber-400 mb-1">⚠️ Não identificado — vincule a um contato antes de confirmar</p>
          <select id="link-\${p.id}" class="w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs">
            <option value="">Escolher contato...</option>
            \${cts.map(c => \`<option value="\${c.telefone.replace(/\\D/g,'')}">\${esc(c.nome)} — \${esc(c.telefone)}</option>\`).join('')}
          </select>
        </div>\`
      : ''
    return \`
    <div class="flex gap-3 bg-gray-800 rounded-xl p-3">
      \${preview}
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium">\${esc(p.nome || 'Sem nome')}</p>
        <p class="text-xs text-gray-500">\${p.telefone ? esc(p.telefone) : 'telefone não identificado'} · \${when} \${isPdf?'· PDF':''}</p>
        <p class="text-xs text-violet-400 cursor-pointer" onclick="openComprovanteInNewTab('\${p.id}')">Abrir \${isPdf?'PDF':'imagem'} em nova aba ↗</p>
        \${linkPicker}
        <div class="flex gap-2 mt-2">
          <button id="btn-confirm-\${p.id}" onclick="confirmPendingPayment('\${p.id}')" class="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs rounded-lg">✓ Confirmar pagamento</button>
          <button onclick="rejectPendingPayment('\${p.id}')" class="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded-lg">✕ Rejeitar</button>
        </div>
      </div>
    </div>
  \`
  }).join('')
}

async function confirmPendingPayment(id) {
  const btn = document.getElementById(\`btn-confirm-\${id}\`)
  const linkSel = document.getElementById(\`link-\${id}\`)
  const telefone = linkSel ? linkSel.value : ''
  if (linkSel && !telefone) { alert('Escolha um contato pra vincular antes de confirmar.'); return }
  if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = 'Confirmando...' }
  const r = await fetch(\`/api/pending-payments/\${id}/confirm\`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ telefone }) }).then(r=>r.json()).catch(()=>({}))
  if (r.error) { alert(r.error); loadPendingPayments(); return }
  alert(r.novoVencimento ? \`Pagamento confirmado! Novo vencimento: \${r.novoVencimento}\` : 'Pagamento confirmado!')
  loadPendingPayments()
}

async function rejectPendingPayment(id) {
  if (!confirm('Rejeitar esse comprovante? Ele vai sumir da lista sem alterar o vencimento.')) return
  await fetch(\`/api/pending-payments/\${id}/reject\`, { method:'POST' })
  loadPendingPayments()
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
    const daysAgo = Math.floor((Date.now() - dt) / 86400000)
    const daysLabel = daysAgo === 0 ? 'hoje' : daysAgo === 1 ? '1 dia atrás' : daysAgo + ' dias atrás'
    const contactList = (h.contacts || []).map(c => \`<li>\${esc(c.nome)} — \${esc(c.telefone)}</li>\`).join('')
    const hasContacts = (h.contacts||[]).length > 0
    const sentCount = h.sent || h.phones?.length || 0
    const responses = h.responses || 0
    const respRate = sentCount > 0 ? Math.round(responses / sentCount * 100) : 0
    const respBadge = responses > 0 ? \`<span class="text-xs text-blue-400">💬 \${responses} respostas (\${respRate}%)</span>\` : ''
    const name = h.templateName || 'Campanha #' + (i+1)
    const srcBadge = name.startsWith('🔁') ? \`<span class="text-xs px-1.5 py-0.5 bg-violet-900/50 text-violet-300 rounded">Drip</span>\`
      : name.startsWith('📅') || h.templateName?.includes('agendad') ? \`<span class="text-xs px-1.5 py-0.5 bg-blue-900/50 text-blue-300 rounded">Agendada</span>\`
      : name.match(/vencimento|dias antes/i) ? \`<span class="text-xs px-1.5 py-0.5 bg-amber-900/50 text-amber-300 rounded">Vencimento</span>\`
      : \`<span class="text-xs px-1.5 py-0.5 bg-gray-700 text-gray-400 rounded">Manual</span>\`
    return \`<div class="px-4 py-3">
      <div class="flex items-center justify-between mb-1 flex-wrap gap-2">
        <div class="flex items-center gap-3 flex-wrap">
          \${srcBadge}
          <span class="text-sm font-medium text-white">\${esc(name)}</span>
          <span class="text-xs text-green-400">✔ \${sentCount} enviadas</span>
          \${(h.failed||0) > 0 ? \`<span class="text-xs text-red-400">✘ \${h.failed} falhas</span>\` : ''}
          \${respBadge}
          <span class="text-xs text-gray-600">\${daysLabel}</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-500">\${dateStr}</span>
          \${hasContacts ? \`<button onclick='startRemarketing(\${JSON.stringify(h).replace(/'/g,"&#39;")})' class="text-xs px-2.5 py-1 bg-amber-900/50 hover:bg-amber-800/70 border border-amber-700/40 text-amber-300 rounded-lg transition-colors font-medium">↩ Remarketar</button>\` : ''}
        </div>
      </div>
      \${contactList ? \`<details class="mt-1"><summary class="text-xs text-gray-500 cursor-pointer hover:text-gray-300">Ver contatos (\${(h.contacts||[]).length})</summary>
        <ul class="mt-1 space-y-0.5 text-xs text-gray-400 pl-3 font-mono">\${contactList}</ul></details>\` : ''}
    </div>\`
  }).join('')
}

function startRemarketing(campaign) {
  const contacts = campaign.contacts || []
  if (!contacts.length) { alert('Campanha sem dados de contatos para remarketar.'); return }
  const daysAgo = Math.floor((Date.now() - new Date(campaign.sentAt)) / 86400000)
  const label = daysAgo === 0 ? 'hoje' : daysAgo === 1 ? '1 dia atrás' : daysAgo + ' dias atrás'
  // Guarda contatos de remarketing
  window._remarketingContacts = contacts
  window._remarketingLabel = \`↩ Remarketing: "\${campaign.templateName||'Campanha'}" (\${contacts.length} contatos · enviada \${label})\`
  // Vai para aba campanha
  tab('campaign')
  // Mostra banner e ativa modo remarketing
  setTimeout(() => {
    let banner = document.getElementById('remarketing-banner')
    if (!banner) {
      banner = document.createElement('div')
      banner.id = 'remarketing-banner'
      const campPanel = document.getElementById('p-campaign')
      campPanel.insertBefore(banner, campPanel.firstChild)
    }
    banner.className = 'bg-amber-950/50 border border-amber-700/40 rounded-xl px-4 py-3 mb-4 flex items-center justify-between gap-3'
    banner.innerHTML = \`
      <div class="flex items-center gap-2">
        <span class="text-amber-400 text-base">↩</span>
        <div>
          <p class="text-sm font-medium text-amber-200">\${esc(window._remarketingLabel)}</p>
          <p class="text-xs text-amber-400/70 mt-0.5">Campanha usará esses \${contacts.length} contatos. Escreva a mensagem de follow-up abaixo.</p>
        </div>
      </div>
      <button onclick="clearRemarketing()" class="text-xs px-2.5 py-1 bg-amber-900/60 hover:bg-amber-800 text-amber-300 rounded-lg transition-colors whitespace-nowrap">✕ Cancelar</button>
    \`
    // Lock group selector to show remarketing source
    const campGroup = document.getElementById('camp-group')
    if (campGroup) {
      campGroup.innerHTML = \`<option value="__remarketing__">↩ Remarketing: \${contacts.length} contatos selecionados</option>\`
      campGroup.disabled = true
      campGroup.style.borderColor = 'rgb(180 83 9 / 0.6)'
      campGroup.style.color = '#fbbf24'
    }
    updateCampSummary()
  }, 100)
}

function clearRemarketing() {
  window._remarketingContacts = null
  window._remarketingLabel = null
  const banner = document.getElementById('remarketing-banner')
  if (banner) banner.remove()
  const campGroup = document.getElementById('camp-group')
  if (campGroup) {
    campGroup.disabled = false
    campGroup.style.borderColor = ''
    campGroup.style.color = ''
    loadGroupsForCampaign()
  }
  updateCampSummary()
}

// ── Opt-out re-include ────────────────────────────────────────────────────────
async function reincludeContact(telefone) {
  await fetch(\`/api/contacts/\${encodeURIComponent(telefone)}/optout\`, { method:'DELETE' })
  await loadContacts()
}

// ── Scheduled campaigns (campaign tab) ───────────────────────────────────────
function toggleSchedForm() {
  const on = document.getElementById('sched-toggle').checked
  document.getElementById('sched-form').classList.toggle('hidden', !on)
  document.getElementById('sched-selection-hint').classList.toggle('hidden', !on)
}

async function scheduleCampaign() {
  const dt = document.getElementById('sched-dt').value
  if (!dt) { alert('Escolha data e hora.'); return }
  const scheduledAt = new Date(dt).toISOString()
  const tpl = document.getElementById('tpl').value.trim()
  if (!tpl) { alert('Mensagem vazia.'); return }
  const groupId = document.getElementById('camp-group').value || ''
  const remarketingContacts = window._remarketingContacts || null
  const contactPhones = remarketingContacts
    ? remarketingContacts.map(c => c.telefone.replace(/\D/g,''))
    : (selected.size > 0 ? contacts.filter((_,i) => selected.has(i)).map(c => c.telefone.replace(/\D/g,'')) : [])
  const delayMin = parseInt(document.getElementById('cfg-dmin').value) || 8000
  const delayMax = parseInt(document.getElementById('cfg-dmax').value) || 20000
  const dailyLimit = parseInt(document.getElementById('cfg-limit').value) || 150
  const useAi = document.getElementById('cfg-ai').checked
  const tplId = window._activeTplId || null
  const tplName = window._activeTplName || 'Sem nome'
  await fetch('/api/schedules', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ template: tpl, templateId: tplId, templateName: tplName, groupId, contactPhones, scheduledAt, delayMin, delayMax, dailyLimit, useAi }) })
  document.getElementById('sched-toggle').checked = false
  document.getElementById('sched-form').classList.add('hidden')
  const qtd = contactPhones.length ? \`\${contactPhones.length} contato(s) selecionado(s)\` : 'todos os contatos do filtro'
  alert(\`Campanha agendada para \${qtd}!\`)
  loadScheduledList()
}

async function loadScheduledList() {
  const list = await fetch('/api/schedules').then(r=>r.json()).catch(()=>[])
  const el = document.getElementById('sched-list')
  if (!el) return
  if (!list.length) { el.innerHTML='<p id="sched-empty" class="text-xs text-gray-600 text-center py-4">Nenhuma campanha agendada.</p>'; return }
  el.innerHTML = list.map(s => {
    const dt = new Date(s.scheduledAt)
    const label = dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})
    const statusColor = s.status==='sent'?'text-green-400':s.status==='failed'?'text-red-400':s.status==='running'?'text-yellow-400':'text-blue-400'
    return \`<div class="flex items-center justify-between bg-gray-800 rounded-xl px-3 py-2">
      <div class="flex-1 min-w-0 mr-3">
        <p class="text-xs font-medium truncate">\${esc(s.templateName||'Campanha')}</p>
        <p class="text-xs text-gray-500">🕐 \${label} \${s.contactPhones?.length ? \`· \${s.contactPhones.length} contato(s) selecionado(s)\` : (s.groupId?'· Grupo selecionado':'')}</p>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs \${statusColor}">\${s.status}</span>
        \${s.status==='pending'?\`<button onclick="deleteSchedule('\${s.id}')" class="text-gray-600 hover:text-red-400 text-xs">✕</button>\`:''}
      </div>
    </div>\`
  }).join('')
}

async function deleteSchedule(id) {
  await fetch(\`/api/schedules/\${id}\`, { method:'DELETE' })
  loadScheduledList()
}

// ── Vencimento rules ──────────────────────────────────────────────────────────
let vfAllContacts = []
let vfAllGroups = []
let vfSelectedPhones = new Set()

async function openVencForm() {
  document.getElementById('venc-form').classList.remove('hidden')
  vfSelectedPhones = new Set()
  document.getElementById('vf-picker-panel').classList.add('hidden')
  document.getElementById('vf-picker-arrow').textContent = '▾'
  const [groups, allContacts, instances] = await Promise.all([
    fetch('/api/groups').then(r=>r.json()).catch(()=>[]),
    fetch('/api/contacts').then(r=>r.json()).catch(()=>[]),
    fetch('/api/instances').then(r=>r.json()).catch(()=>[])
  ])
  vfAllGroups = groups
  vfAllContacts = allContacts
  const sel = document.getElementById('vf-group')
  sel.innerHTML = '<option value="">Todos os contatos</option>' + groups.map(g=>\`<option value="\${g.id}">📁 \${esc(g.name)}</option>\`).join('')
  const instSel = document.getElementById('vf-instance')
  const activeInstances = instances.filter(i => i.enabled !== false)
  instSel.innerHTML = '<option value="">Padrão da conta</option>' + activeInstances.map(i=>\`<option value="\${esc(i.instanceName)}">📱 \${esc(i.label||i.instanceName)}</option>\`).join('')
  renderVfPicker()
}

function closeVencForm() {
  document.getElementById('venc-form').classList.add('hidden')
  document.getElementById('vf-name').value=''
  document.getElementById('vf-days').value='3'
  document.getElementById('vf-content').value=''
  document.getElementById('vf-group').value=''
  document.getElementById('vf-instance').value=''
  vfSelectedPhones = new Set()
}

function toggleVfPicker() {
  const panel = document.getElementById('vf-picker-panel')
  const isHidden = panel.classList.contains('hidden')
  panel.classList.toggle('hidden', !isHidden)
  document.getElementById('vf-picker-arrow').textContent = isHidden ? '▴' : '▾'
}

async function loadVfContactsPicker() {
  vfSelectedPhones = new Set()
  renderVfPicker()
}

function renderVfPicker() {
  const groupId = document.getElementById('vf-group').value
  const grp = groupId ? vfAllGroups.find(g => g.id === groupId) : null
  const lista = (grp ? vfAllContacts.filter(c => phoneInGroup(grp, c.telefone)) : [...vfAllContacts])
    .sort((a,b) => (a.nome||'').localeCompare(b.nome||'', 'pt-BR'))

  const panel = document.getElementById('vf-picker-panel')
  if (!lista.length) {
    panel.innerHTML = '<p class="text-xs text-gray-600 text-center py-3">Nenhum contato nesse grupo.</p>'
  } else {
    panel.innerHTML = lista.map(c => {
      const phone = c.telefone.replace(/\D/g,'')
      const checked = vfSelectedPhones.has(phone) ? 'checked' : ''
      return \`
      <label class="flex items-center gap-2 px-2 py-1.5 hover:bg-gray-800 rounded-lg cursor-pointer">
        <input type="checkbox" \${checked} onchange="toggleVfContact('\${phone}', this.checked)" class="w-3.5 h-3.5 accent-violet-600"/>
        <span class="text-xs text-gray-300">\${esc(c.nome)}</span>
        <span class="text-xs text-gray-600 ml-auto">\${phone}</span>
      </label>\`
    }).join('')
  }
  updateVfPickerSummary()
}

function toggleVfContact(phone, checked) {
  if (checked) vfSelectedPhones.add(phone)
  else vfSelectedPhones.delete(phone)
  updateVfPickerSummary()
}

function updateVfPickerSummary() {
  const el = document.getElementById('vf-picker-summary')
  if (vfSelectedPhones.size === 0) {
    el.textContent = 'Enviar pra todo mundo do grupo (clique pra escolher pessoas específicas)'
    el.className = 'text-gray-400'
    return
  }
  const nomes = vfAllContacts
    .filter(c => vfSelectedPhones.has(c.telefone.replace(/\D/g,'')))
    .map(c => c.nome)
  const preview = nomes.slice(0, 3).join(', ') + (nomes.length > 3 ? \` e mais \${nomes.length - 3}\` : '')
  el.textContent = \`👤 \${vfSelectedPhones.size} selecionado(s): \${preview}\`
  el.className = 'text-violet-300'
}

async function saveVencRule() {
  const name = document.getElementById('vf-name').value.trim()
  const daysBefore = parseInt(document.getElementById('vf-days').value) || 3
  const groupId = document.getElementById('vf-group').value
  const instanceName = document.getElementById('vf-instance').value
  const templateContent = document.getElementById('vf-content').value.trim()
  if (!name || !templateContent) { alert('Preencha nome e mensagem.'); return }
  const contactPhones = [...vfSelectedPhones]
  await fetch('/api/vencimento-rules', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, daysBefore, groupId, contactPhones, instanceName, templateContent }) })
  closeVencForm()
  loadVencimentoRules()
}

function parseVencimentoDateJS(str) {
  if (!str) return null
  str = str.trim()
  let parts = str.split('/')
  if (parts.length === 3) {
    const d = parseInt(parts[0]), mo = parseInt(parts[1]), y = parseInt(parts[2])
    if (d && mo && y) return new Date(y, mo - 1, d)
  }
  if (parts.length === 2) {
    const d = parseInt(parts[0]), mo = parseInt(parts[1])
    if (d && mo) return new Date(new Date().getFullYear(), mo - 1, d)
  }
  parts = str.split('-')
  if (parts.length === 3 && parts[0].length === 4) {
    const y = parseInt(parts[0]), mo = parseInt(parts[1]), d = parseInt(parts[2])
    if (y && mo && d) return new Date(y, mo - 1, d)
  }
  return null
}

function fmtDataBr(d) {
  return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear()
}

async function loadVencimentoRules() {
  const rules = await fetch('/api/vencimento-rules').then(r=>r.json()).catch(()=>[])
  const el = document.getElementById('venc-list')
  if (!rules.length) { el.innerHTML='<p class="text-xs text-gray-600 text-center py-4">Nenhuma regra criada.</p>'; return }
  const [groups, allContacts, instances] = await Promise.all([
    fetch('/api/groups').then(r=>r.json()).catch(()=>[]),
    fetch('/api/contacts').then(r=>r.json()).catch(()=>[]),
    fetch('/api/instances').then(r=>r.json()).catch(()=>[])
  ])
  el.innerHTML = rules.map(r => {
    const grp = r.groupId ? groups.find(g => g.id === r.groupId) : null
    const groupTag = r.contactPhones?.length
      ? \`👤 \${r.contactPhones.length} contato(s) selecionado(s)\`
      : (grp ? \`📁 \${esc(grp.name)}\` : (r.groupId ? '⚠️ grupo excluído' : 'Todos os contatos'))
    const inst = r.instanceName ? instances.find(i => i.instanceName === r.instanceName) : null
    const instTag = r.instanceName ? \`📱 \${esc(inst?.label || r.instanceName)}\` : '📱 Padrão da conta'

    let previewLine = ''
    if (r.contactPhones?.length) {
      const previews = r.contactPhones.map(phone => {
        const c = allContacts.find(c => c.telefone.replace(/\D/g,'') === phone)
        if (!c) return null
        const vencDate = parseVencimentoDateJS(c.vencimento)
        if (!vencDate) return { nome: c.nome, texto: 'vencimento inválido' }
        const disparoDate = new Date(vencDate)
        disparoDate.setDate(disparoDate.getDate() - parseInt(r.daysBefore))
        return { nome: c.nome, texto: fmtDataBr(disparoDate) }
      }).filter(Boolean)
      if (previews.length) {
        previewLine = \`<p class="text-xs text-gray-600 mt-0.5">Dispara em: \${previews.map(p => \`\${p.texto} (\${esc(p.nome)})\`).join(' · ')}</p>\`
      }
    }

    return \`
    <div class="flex items-center justify-between bg-gray-800 rounded-xl px-3 py-2.5">
      <div class="flex-1 min-w-0 mr-3">
        <p class="text-xs font-medium">\${esc(r.name)}</p>
        <p class="text-xs text-gray-500">\${r.daysBefore} dia\${r.daysBefore!==1?'s':''} antes do vencimento · \${groupTag} · \${instTag}</p>
        \${previewLine}
      </div>
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-1 cursor-pointer">
          <input type="checkbox" \${r.active?'checked':''} onchange="toggleVencRule('\${r.id}',this.checked)" class="w-3.5 h-3.5 accent-violet-600"/>
          <span class="text-xs text-gray-400">Ativo</span>
        </label>
        <button onclick="deleteVencRule('\${r.id}')" class="text-gray-600 hover:text-red-400 text-xs ml-1">✕</button>
      </div>
    </div>
  \`
  }).join('')
}

async function toggleVencRule(id, active) {
  await fetch(\`/api/vencimento-rules/\${id}\`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ active }) })
}

async function deleteVencRule(id) {
  if (!confirm('Excluir esta regra?')) return
  await fetch(\`/api/vencimento-rules/\${id}\`, { method:'DELETE' })
  loadVencimentoRules()
}

// ── Auto-reply follow-up steps ────────────────────────────────────────────────

function addFollowupStep() {
  _followupSteps.push({ delayHours: _followupSteps.length === 0 ? 1 : 24, message: '' })
  renderFollowupSteps()
}

function removeFollowupStep(i) { _followupSteps.splice(i, 1); renderFollowupSteps() }

function renderFollowupSteps() {
  const el = document.getElementById('ar-followup-steps')
  if (!_followupSteps.length) { el.innerHTML = '<p class="text-xs text-gray-700 text-center py-2">Nenhum seguimento configurado.</p>'; return }
  el.innerHTML = _followupSteps.map((s, i) => \`
    <div class="bg-gray-800/60 border border-gray-700 rounded-xl p-3 space-y-2">
      <div class="flex items-center gap-2">
        <span class="text-xs text-gray-500 shrink-0">↩ Etapa \${i+1} — enviar após</span>
        <input type="number" value="\${s.delayHours}" min="1" max="720" oninput="_followupSteps[\${i}].delayHours=Math.max(1,+this.value||1)"
          class="w-16 bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-violet-500"/>
        <span class="text-xs text-gray-500">hora(s)</span>
        <button onclick="removeFollowupStep(\${i})" class="ml-auto text-gray-600 hover:text-red-400 text-xs">✕</button>
      </div>
      <textarea rows="2" placeholder="Mensagem (use {nome}, {empresa}...)" oninput="_followupSteps[\${i}].message=this.value"
        class="w-full bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-violet-500 resize-none">\${esc(s.message)}</textarea>
    </div>\`).join('')
}

// ── Drip campaigns ────────────────────────────────────────────────────────────
let dripSteps = []

function openDripForm() {
  dripSteps = [
    { delayDays: 0, message: '' },
    { delayDays: 3, message: '' }
  ]
  document.getElementById('drip-form').classList.remove('hidden')
  renderDripSteps()
}
function closeDripForm() { document.getElementById('drip-form').classList.add('hidden'); document.getElementById('df-name').value=''; dripSteps=[] }

function addDripStep() {
  const idx = dripSteps.length
  dripSteps.push({ delayDays: idx === 0 ? 0 : 1, message: '' })
  renderDripSteps()
}

function renderDripSteps() {
  let cumDays = 0
  document.getElementById('df-steps').innerHTML = dripSteps.map((s, i) => {
    if (i > 0) cumDays += s.delayDays
    const dayLabel = i === 0 ? 'Dia 0 — enviado imediatamente ao iniciar' : \`Dia +\${cumDays} após o início\`
    return \`
    <div class="flex gap-2">
      <div class="flex flex-col items-center pt-1">
        <div class="w-6 h-6 rounded-full bg-violet-700 text-white text-xs flex items-center justify-center font-bold flex-shrink-0">\${i+1}</div>
        \${i < dripSteps.length-1 ? '<div class="w-px flex-1 bg-gray-700 mt-1 mb-1"></div>' : ''}
      </div>
      <div class="flex-1 bg-gray-900 rounded-xl p-3 space-y-2 mb-2">
        <div class="flex items-center justify-between">
          <span class="text-xs text-violet-400 font-medium">\${dayLabel}</span>
          \${dripSteps.length > 1 ? \`<button onclick="removeDripStep(\${i})" class="text-gray-600 hover:text-red-400 text-xs">✕</button>\` : ''}
        </div>
        \${i > 0 ? \`<div class="flex items-center gap-2">
          <label class="text-xs text-gray-500 whitespace-nowrap">Enviar</label>
          <input type="number" value="\${s.delayDays}" min="1" oninput="dripSteps[\${i}].delayDays=Math.max(1,+this.value||1); renderDripSteps()" class="w-16 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-xs focus:outline-none focus:border-violet-500"/>
          <label class="text-xs text-gray-500">dias depois da etapa anterior</label>
        </div>\` : ''}
        <textarea rows="3" placeholder="Mensagem (use {nome}, {empresa}, {extra}...)" oninput="dripSteps[\${i}].message=this.value" class="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-violet-500 resize-none">\${esc(s.message)}</textarea>
      </div>
    </div>\`
  }).join('')
}

function removeDripStep(i) { dripSteps.splice(i, 1); renderDripSteps() }

async function saveDrip() {
  const name = document.getElementById('df-name').value.trim()
  if (!name) { alert('Digite o nome da sequência.'); return }
  if (!dripSteps.length) { alert('Adicione ao menos uma etapa.'); return }
  if (dripSteps.some(s => !s.message.trim())) { alert('Todas as etapas precisam de mensagem.'); return }
  await fetch('/api/drips', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, steps: dripSteps }) })
  closeDripForm()
  loadDrips()
}

async function loadDrips() {
  const drips = await fetch('/api/drips').then(r=>r.json()).catch(()=>[])
  const el = document.getElementById('drip-list')
  if (!drips.length) { el.innerHTML='<p class="text-xs text-gray-600 text-center py-4">Nenhuma sequência criada.</p>'; return }
  const groups = await fetch('/api/groups').then(r=>r.json()).catch(()=>[])
  el.innerHTML = drips.map(d => {
    const steps = Array.isArray(d.steps) ? d.steps : []
    let cum = 0
    const timeline = steps.map((s, i) => {
      if (i > 0) cum += (s.delayDays || 1)
      const dayTag = i === 0 ? 'Dia 0' : \`Dia +\${cum}\`
      const preview = (s.message || '').slice(0, 40) + ((s.message||'').length > 40 ? '…' : '')
      return \`<div class="flex items-start gap-2">
        <span class="text-xs text-violet-400 whitespace-nowrap font-medium w-12">\${dayTag}</span>
        <span class="text-xs text-gray-400">\${esc(preview) || '<em class="text-gray-600">sem mensagem</em>'}</span>
      </div>\`
    }).join('')
    return \`
    <div class="bg-gray-800 rounded-xl px-4 py-3 space-y-3">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-xs font-semibold">\${esc(d.name)}</p>
          <p class="text-xs text-gray-500">\${steps.length} etapa\${steps.length!==1?'s':''}</p>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="startDrip('\${d.id}')" class="text-xs px-2.5 py-1 bg-violet-700 hover:bg-violet-600 text-white rounded-lg">▶ Iniciar</button>
          <button onclick="deleteDrip('\${d.id}')" class="text-gray-600 hover:text-red-400 text-xs px-1">✕</button>
        </div>
      </div>
      <div class="border-t border-gray-700 pt-2 space-y-1.5">\${timeline}</div>
    </div>\`
  }).join('')
}

let _dripStartId = null
async function startDrip(id) {
  _dripStartId = id
  const [groups, instances] = await Promise.all([
    fetch('/api/groups').then(r=>r.json()).catch(()=>[]),
    fetch('/api/instances').then(r=>r.json()).catch(()=>[])
  ])
  const instSel = document.getElementById('drip-start-instance')
  const enabledInstances = instances.filter(i => i.enabled !== false)
  instSel.innerHTML = enabledInstances.length
    ? enabledInstances.map(i => \`<option value="\${esc(i.instanceName)}">\${esc(i.label || i.instanceName)} (\${esc(i.instanceName)})</option>\`).join('')
    : '<option value="">Nenhum WhatsApp habilitado</option>'
  const sel = document.getElementById('drip-start-group')
  sel.innerHTML = '<option value="">Todos os contatos</option>' + groups.map(g=>\`<option value="\${g.id}">📁 \${esc(g.name)}</option>\`).join('')
  document.getElementById('drip-start-modal').classList.remove('hidden')
}
function closeDripStartModal() { document.getElementById('drip-start-modal').classList.add('hidden'); _dripStartId = null }
async function confirmStartDrip() {
  const groupId = document.getElementById('drip-start-group').value
  const instanceName = document.getElementById('drip-start-instance').value
  if (!instanceName) { alert('Habilite um WhatsApp antes de iniciar a sequência.'); return }
  const body = { instanceName, ...(groupId ? { groupId } : {}) }
  const btn = document.querySelector('#drip-start-modal button')
  btn.disabled = true; btn.textContent = 'Iniciando...'
  const r = await fetch(\`/api/drips/\${_dripStartId}/start\`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }).then(r=>r.json()).catch(()=>({}))
  closeDripStartModal()
  const msg = r.enrolled != null ? \`✔ Sequência iniciada para \${r.enrolled} contato\${r.enrolled!==1?'s':''}!\` : '❌ Erro ao iniciar sequência.'
  const toast = document.createElement('div')
  toast.className = 'fixed bottom-4 right-4 bg-gray-800 border border-gray-700 text-white text-sm px-4 py-2.5 rounded-xl shadow-lg z-50'
  toast.textContent = msg
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 3500)
}

async function deleteDrip(id) {
  if (!confirm('Excluir esta sequência e todos os agendamentos pendentes?')) return
  await fetch(\`/api/drips/\${id}\`, { method:'DELETE' })
  loadDrips()
}

// ── Init ──────────────────────────────────────────────────────────────────────
checkStatus()
loadInstances()
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
<title>ZapVibe — Disparador de WhatsApp em Massa para Empresas</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%231E1B4B'/><path d='M20 3L9 18h7l-4 11 14-16h-8z' fill='%238B5CF6'/></svg>">
<meta name="description" content="Dispare mensagens em massa no WhatsApp usando seu próprio número. Automatize campanhas, respostas e follow-ups. Sem risco de ban. Teste 7 dias grátis.">
<meta name="keywords" content="disparador whatsapp, envio em massa whatsapp, whatsapp marketing, automação whatsapp, campanha whatsapp, disparador whatsapp sem ban, whatsapp para empresas, software whatsapp marketing">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:title" content="ZapVibe — Disparador de WhatsApp em Massa para Empresas">
<meta property="og:description" content="Dispare mensagens em massa no WhatsApp usando seu próprio número. Automatize campanhas e responda clientes automaticamente.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"ZapVibe","applicationCategory":"BusinessApplication","operatingSystem":"Web","description":"Plataforma de disparos em massa e automação de mensagens no WhatsApp para empresas","offers":{"@type":"Offer","price":"0","priceCurrency":"BRL","description":"7 dias grátis"}}</script>
<script src="https://cdn.tailwindcss.com"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{font-family:'Inter',sans-serif}
.gradient-text{background:linear-gradient(135deg,#7c3aed,#a855f7,#ec4899);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.card-hover{transition:all .25s;border:1px solid transparent}
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
    <div class="hidden md:flex items-center gap-6 text-sm text-gray-400">
      <a href="#como-funciona" class="hover:text-white transition-colors">Como funciona</a>
      <a href="#features" class="hover:text-white transition-colors">Funcionalidades</a>
      <a href="#faq" class="hover:text-white transition-colors">FAQ</a>
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
    Dispare mensagens em massa<br><span class="gradient-text">no WhatsApp sem complicação</span>
  </h1>
  <p class="text-gray-400 text-lg max-w-2xl mx-auto mb-10">
    Use seu próprio número para enviar campanhas personalizadas para centenas de clientes, automatizar respostas e acompanhar resultados — tudo em um painel simples, sem risco de ban.
  </p>
  <div class="flex flex-col sm:flex-row gap-3 justify-center mb-8">
    <a href="/register" class="px-8 py-3.5 bg-violet-600 hover:bg-violet-500 text-white font-semibold rounded-xl transition-colors text-base">Testar 7 dias grátis →</a>
    <a href="#como-funciona" class="px-8 py-3.5 bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium rounded-xl transition-colors text-base">Como funciona</a>
  </div>
  <p class="text-xs text-gray-600">Sem cartão de crédito · Acesso em minutos · Cancele quando quiser</p>
  <div class="mt-14 grid grid-cols-3 gap-4 max-w-lg mx-auto">
    <div class="bg-gray-900/60 border border-gray-800 rounded-2xl px-4 py-5">
      <p class="text-2xl font-extrabold text-violet-400">150+</p>
      <p class="text-xs text-gray-500 mt-1">msgs/dia por conta</p>
    </div>
    <div class="bg-gray-900/60 border border-gray-800 rounded-2xl px-4 py-5">
      <p class="text-2xl font-extrabold text-violet-400">7 dias</p>
      <p class="text-xs text-gray-500 mt-1">de teste grátis</p>
    </div>
    <div class="bg-gray-900/60 border border-gray-800 rounded-2xl px-4 py-5">
      <p class="text-2xl font-extrabold text-violet-400">5 min</p>
      <p class="text-xs text-gray-500 mt-1">para configurar</p>
    </div>
  </div>
</section>

<!-- Como funciona -->
<section id="como-funciona" class="max-w-5xl mx-auto px-4 py-16">
  <h2 class="text-2xl sm:text-3xl font-bold text-center mb-3">Como funciona</h2>
  <p class="text-gray-400 text-center mb-12 max-w-lg mx-auto text-sm">Em menos de 5 minutos você está enviando sua primeira campanha.</p>
  <div class="grid md:grid-cols-3 gap-6">
    ${[
      ['1','Conecte seu WhatsApp','Escaneie o QR code com seu celular. Sem número virtual, sem aprovação do Meta. Usa seu número atual.','📱'],
      ['2','Importe seus contatos','Faça upload de uma planilha CSV ou cadastre manualmente. Organize por grupos e personalize cada mensagem.','📋'],
      ['3','Dispare e acompanhe','Escolha o template, configure o horário e dispare. Veja em tempo real quem recebeu e quem respondeu.','🚀'],
    ].map(([n, title, desc, icon]) => `
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-6 text-center">
      <div class="w-10 h-10 rounded-full bg-violet-600/20 border border-violet-600/40 flex items-center justify-center text-violet-400 font-bold text-sm mx-auto mb-4">${n}</div>
      <div class="text-3xl mb-3">${icon}</div>
      <h3 class="font-semibold mb-2">${title}</h3>
      <p class="text-sm text-gray-400 leading-relaxed">${desc}</p>
    </div>`).join('')}
  </div>
</section>

<!-- Features -->
<section id="features" class="max-w-6xl mx-auto px-4 py-16">
  <h2 class="text-2xl sm:text-3xl font-bold text-center mb-3">Tudo que você precisa para vender pelo WhatsApp</h2>
  <p class="text-gray-400 text-center mb-12 max-w-xl mx-auto text-sm">Uma plataforma completa para escalar sua comunicação sem precisar de equipe grande.</p>
  <div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
    ${[
      ['📤','Disparos em massa','Envie mensagens para centenas de contatos com delay inteligente entre envios. Zero risco de ban.'],
      ['🎯','Personalização por contato','Use variáveis {nome}, {empresa} e {vencimento}. Cada mensagem parece escrita na mão.'],
      ['💬','Auto-respostas automáticas','Configure respostas por palavra-chave. Atenda leads automaticamente, 24h por dia.'],
      ['📅','Agendamento de campanhas','Programe para o melhor horário. Configure e esqueça — o sistema dispara sozinho.'],
      ['📁','Mídia nas mensagens','Envie imagens, vídeos, áudios e PDFs junto com o texto. Salve mídias no template.'],
      ['📊','Relatórios em tempo real','Acompanhe enviados, falhas e respostas de cada campanha. Decisões baseadas em dados.'],
      ['🔄','Sequências automáticas','Crie drip campaigns com múltiplas etapas. Nutra leads automaticamente ao longo dos dias.'],
      ['👥','Múltiplos WhatsApps','Conecte até 5 números diferentes. Ideal para times ou diferentes linhas de negócio.'],
      ['🔔','Alertas de vencimento','Notifique clientes antes do vencimento. Reduza inadimplência sem esforço manual.'],
    ].map(([icon, title, desc]) => `
    <div class="card-hover bg-gray-900 rounded-2xl p-5">
      <div class="text-3xl mb-3">${icon}</div>
      <h3 class="font-semibold text-base mb-2">${title}</h3>
      <p class="text-sm text-gray-400 leading-relaxed">${desc}</p>
    </div>`).join('')}
  </div>
</section>

<!-- Para quem é -->
<section class="max-w-5xl mx-auto px-4 py-16">
  <h2 class="text-2xl sm:text-3xl font-bold text-center mb-3">Para quem é o ZapVibe?</h2>
  <p class="text-gray-400 text-center mb-10 text-sm">Qualquer negócio que usa WhatsApp para se comunicar com clientes.</p>
  <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
    ${[
      ['🛍️','Lojas e e-commerce','Promoções, recuperação de carrinho, notificações de pedido'],
      ['🏥','Clínicas e consultórios','Lembretes de consulta, confirmações, campanhas sazonais'],
      ['🏠','Imobiliárias','Follow-up de leads, lançamentos, aniversário de contratos'],
      ['📚','Infoprodutores','Lançamentos, sequências de engajamento, suporte ao aluno'],
      ['💈','Salões e estéticas','Agendamentos, promoções, fidelização de clientes'],
      ['🏋️','Academias e studios','Renovações, horários, campanhas de retenção'],
      ['🍕','Restaurantes e deliveries','Cardápio, promoções do dia, fidelização'],
      ['💼','Freelancers e agências','Prospecção, follow-up de propostas, relacionamento'],
    ].map(([icon, title, desc]) => `
    <div class="bg-gray-900 border border-gray-800 rounded-2xl p-4">
      <div class="text-2xl mb-2">${icon}</div>
      <h3 class="font-semibold text-sm mb-1">${title}</h3>
      <p class="text-xs text-gray-500 leading-relaxed">${desc}</p>
    </div>`).join('')}
  </div>
</section>

<!-- FAQ -->
<section id="faq" class="max-w-3xl mx-auto px-4 py-16">
  <h2 class="text-2xl sm:text-3xl font-bold text-center mb-10">Perguntas frequentes</h2>
  <div class="space-y-3">
    ${[
      ['Preciso de aprovação do Meta ou número especial?','Não. O ZapVibe usa seu número de WhatsApp pessoal ou comercial normal. Basta escanear o QR code com seu celular.'],
      ['Posso tomar ban usando disparador?','O ZapVibe aplica delays automáticos entre mensagens e limite diário configurável. Seguindo boas práticas, o risco é mínimo.'],
      ['Funciona com WhatsApp Business?','Sim, funciona com WhatsApp pessoal e WhatsApp Business.'],
      ['Como importo meus contatos?','Basta fazer upload de um arquivo CSV. O sistema detecta o delimitador automaticamente e importa nome, telefone, empresa e outros campos.'],
      ['O que acontece após os 7 dias de teste?','Entraremos em contato para apresentar os planos. Seus dados ficam salvos durante o período.'],
      ['Posso conectar mais de um WhatsApp?','Sim. Dependendo do seu plano, você pode conectar até 5 números diferentes na mesma conta.'],
    ].map(([q, a]) => `
    <details class="bg-gray-900 border border-gray-800 rounded-2xl group">
      <summary class="px-5 py-4 cursor-pointer text-sm font-medium flex items-center justify-between list-none select-none">
        ${q}<span class="text-gray-500 text-lg ml-3">+</span>
      </summary>
      <p class="px-5 pb-4 text-sm text-gray-400 leading-relaxed">${a}</p>
    </details>`).join('')}
  </div>
</section>

<!-- CTA -->
<section class="max-w-3xl mx-auto px-4 py-16 text-center">
  <div class="bg-gradient-to-br from-violet-950/60 to-purple-950/60 border border-violet-800/40 rounded-3xl p-10">
    <h2 class="text-2xl sm:text-3xl font-bold mb-4">Comece grátis agora</h2>
    <p class="text-gray-400 mb-2 text-sm">Crie sua conta em 1 minuto. Sem cartão de crédito.</p>
    <p class="text-gray-500 mb-8 text-xs">Sua primeira campanha pode sair hoje mesmo.</p>
    <a href="/register" class="inline-block px-8 py-3.5 bg-violet-600 hover:bg-violet-500 text-white font-semibold rounded-xl transition-colors text-base">Criar conta grátis →</a>
    <p class="text-xs text-gray-600 mt-5">Dúvidas? <a href="http://wa.link/k3gl1y" target="_blank" class="text-green-500 hover:text-green-400">Fale com a gente no WhatsApp</a></p>
  </div>
</section>

<!-- Suporte flutuante -->
<a href="http://wa.link/k3gl1y" target="_blank"
   class="fixed bottom-5 right-5 btn-wpp text-white px-4 py-3 rounded-2xl shadow-lg flex items-center gap-2 text-sm font-medium z-50">
  💬 <span class="hidden sm:inline">Suporte via WhatsApp</span>
</a>

<!-- Footer -->
<footer class="border-t border-gray-800/50 py-10 text-center text-xs text-gray-600">
  <div class="max-w-6xl mx-auto px-4">
    <div class="flex items-center justify-center gap-2 mb-4">
      <div class="w-6 h-6 rounded-lg bg-violet-600 flex items-center justify-center text-sm">⚡</div>
      <span class="font-semibold text-gray-400">ZapVibe</span>
    </div>
    <p class="mb-2">Plataforma de disparos e automação de mensagens no WhatsApp para empresas brasileiras.</p>
    <p>© ${new Date().getFullYear()} ZapVibe. Todos os direitos reservados. ·
      <a href="http://wa.link/k3gl1y" target="_blank" class="hover:text-gray-400 transition-colors">Suporte</a> ·
      <a href="/login" class="hover:text-gray-400 transition-colors">Login</a>
    </p>
  </div>
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
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%231E1B4B'/><path d='M20 3L9 18h7l-4 11 14-16h-8z' fill='%238B5CF6'/></svg>">
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
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%231E1B4B'/><path d='M20 3L9 18h7l-4 11 14-16h-8z' fill='%238B5CF6'/></svg>">
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
          <div class="flex items-center gap-1">
            <span class="text-xs text-gray-500">📱</span>
            <select onchange="setMaxInstances(\${u.id},this.value)" title="Máx. instâncias WhatsApp" class="text-xs bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 focus:outline-none">
              \${[1,2,3,4,5].map(n=>\`<option value="\${n}" \${(u.max_instances||1)===n?'selected':''}>\${n} zap\${n!==1?'s':''}</option>\`).join('')}
            </select>
          </div>
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

async function setMaxInstances(id, max_instances) {
  await fetch(\`/api/admin/users/\${id}\`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ max_instances: parseInt(max_instances) }) })
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
  const fullUrl = req.url || '/'
  const parsedUrl = new URL(fullUrl, 'http://localhost')
  const url = parsedUrl.pathname
  const method = req.method

  const json = (data, code = 200) => {
    if (res.headersSent) return
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  const handleRequest = async () => {
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
    json({ ok: true })
    notifyAdminNewUser(name, email, phone).catch(e => console.error('[notify] falha ao enviar email:', e.message))
    return
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

  // Webhook — público, autenticado por token (planilha Google/Excel chama esta)
  if (url === '/api/contacts/webhook' && method === 'POST') {
    const body = await readBody(req)
    const user = await db.getUserByWebhookToken(body.token).catch(() => null)
    if (!user) { json({ error: 'Token inválido' }, 401); return }
    const telefone = (body.telefone || '').toString().trim()
    if (!telefone) { json({ error: 'telefone obrigatório' }, 400); return }
    try {
      const r = await db.upsertContactByPhone({
        nome: body.nome || '', telefone, empresa: body.empresa || '', extra: body.extra || '', vencimento: body.vencimento || ''
      }, user.id)
      json({ ok: true, ...r })
    } catch (e) {
      json({ error: e.message }, 400)
    }
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
    const next = encodeURIComponent(fullUrl)
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

  // Current user info
  if (url === '/api/me' && method === 'GET') {
    json({ id: userId, email: authUser.email, max_instances: authUser.max_instances || 1, role: authUser.role }); return
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
      configureWebhookForInstance(userInstance).catch(() => {})
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
  if (url === '/api/contacts/webhook-info' && method === 'GET') {
    const token = await db.getOrCreateWebhookToken(userId)
    const baseUrl = process.env.WEBHOOK_BASE_URL || `http://host.docker.internal:${PORT}`
    json({ token, url: `${baseUrl}/api/contacts/webhook` }); return
  }

  if (url === '/api/funnel/stages' && method === 'GET') {
    json(await db.getFunnelStages(userId)); return
  }
  if (url === '/api/funnel/stages' && method === 'POST') {
    const body = await readBody(req)
    if (!body.name?.trim()) { json({ error: 'nome obrigatório' }, 400); return }
    json(await db.addFunnelStage(body.name.trim(), userId)); return
  }
  if (url.startsWith('/api/funnel/stages/') && method === 'PUT') {
    const id = url.split('/')[4]
    const body = await readBody(req)
    await db.updateFunnelStage(id, body, userId)
    json({ ok: true }); return
  }
  if (url.startsWith('/api/funnel/stages/') && method === 'DELETE') {
    const id = url.split('/')[4]
    await db.deleteFunnelStage(id, userId)
    json({ ok: true }); return
  }
  if (url === '/api/funnel/cards' && method === 'GET') {
    json(await db.getFunnelCards(userId)); return
  }
  if (url === '/api/funnel/cards' && method === 'POST') {
    const body = await readBody(req)
    if (!body.nome?.trim()) { json({ error: 'nome obrigatório' }, 400); return }
    json(await db.addFunnelCard(body, userId)); return
  }
  if (url.startsWith('/api/funnel/cards/') && method === 'PUT') {
    const id = url.split('/')[4]
    const body = await readBody(req)
    await db.updateFunnelCard(id, body, userId)
    json({ ok: true }); return
  }
  if (url.startsWith('/api/funnel/cards/') && method === 'DELETE') {
    const id = url.split('/')[4]
    await db.deleteFunnelCard(id, userId)
    json({ ok: true }); return
  }

  if (url === '/api/pending-payments' && method === 'GET') {
    json(await db.getPendingPayments(userId)); return
  }
  if (url.startsWith('/api/pending-payments/') && url.endsWith('/confirm') && method === 'POST') {
    const id = url.split('/')[3]
    const body = await readBody(req).catch(() => ({}))
    const r = await db.confirmPendingPayment(id, userId, body.telefone || '')
    if (r.ok) {
      const userRow = await db.getUserById(userId).catch(() => null)
      const instanceName = r.instanceName || userRow?.instance_name || INSTANCE
      const msg = r.novoVencimento
        ? `Pagamento confirmado! ✅ Sua renovação foi atualizada, novo vencimento: ${r.novoVencimento}. Obrigado!`
        : `Pagamento confirmado! ✅ Obrigado!`
      sendWhatsapp(r.jid || r.telefone, msg, instanceName).catch(() => {})
    }
    json(r); return
  }
  if (url.startsWith('/api/pending-payments/') && url.endsWith('/reject') && method === 'POST') {
    const id = url.split('/')[3]
    await db.rejectPendingPayment(id, userId)
    json({ ok: true }); return
  }

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
      createdAt: new Date().toISOString(),
      templateId: body.templateId || null,
      templateName: body.templateName || null,
      activeDays: body.activeDays || null,
      activeStart: body.activeStart || null,
      activeEnd: body.activeEnd || null,
      offHoursMsg: body.offHoursMsg || null,
      followupSteps: body.followupSteps || [],
      instanceName: body.instanceName || null
    }
    await db.addAutoreply(rule, userId)
    json(rule); return
  }

  if (url.startsWith('/api/autoreplies/') && method === 'PUT') {
    const id = url.split('/')[3]
    const body = await readBody(req)
    console.log('[PUT autoreply]', id, 'templateId:', body.templateId, 'instanceName:', body.instanceName, 'active:', body.active)
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

  if (url.startsWith('/api/templates/') && method === 'GET') {
    const id = url.split('/')[3]
    const tpl = await db.getTemplateById(id, userId)
    if (!tpl) { json({ error: 'not found' }, 404); return }
    json(tpl); return
  }

  if (url === '/api/templates' && method === 'POST') {
    const body = await readBody(req)
    if (!body.name?.trim() || !body.content?.trim()) { json({ error: 'name e content obrigatórios' }, 400); return }
    if (body.media_data && body.media_type) {
      const byteSize = Math.floor(body.media_data.length * 3 / 4)
      const limit = MEDIA_LIMITS[body.media_type] || 5*1024*1024
      if (byteSize > limit) { json({ error: `Arquivo muito grande. Limite: ${limit/1024/1024}MB` }, 400); return }
    }
    const tpl = {
      id: Date.now().toString(), name: body.name.trim(), content: body.content.trim(),
      mediaType: body.media_data ? (body.media_type || null) : null,
      mediaData: body.media_data || null,
      mediaName: body.media_name || null,
      mediaMimetype: body.media_mimetype || null,
      createdAt: new Date().toISOString()
    }
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
    if (body.media_data && body.media_type) {
      const byteSize = Math.floor(body.media_data.length * 3 / 4)
      const limit = MEDIA_LIMITS[body.media_type] || 5*1024*1024
      if (byteSize > limit) { json({ error: `Arquivo muito grande. Limite: ${limit/1024/1024}MB` }, 400); return }
    }
    await db.updateTemplate(id, {
      name: body.name?.trim(),
      content: body.content?.trim(),
      mediaType: body.media_data !== undefined ? (body.media_data ? body.media_type : null) : undefined,
      mediaData: body.media_data !== undefined ? (body.media_data || null) : undefined,
      mediaName: body.media_data !== undefined ? (body.media_name || null) : undefined,
      mediaMimetype: body.media_data !== undefined ? (body.media_mimetype || null) : undefined
    }, userId)
    json({ ok: true }); return
  }

  // Campaign
  if (url === '/api/campaign/start' && method === 'POST') {
    const c_ = getCampaign(userId)
    if (c_.running) { json({ error: 'Campanha já em andamento' }, 400); return }
    const body = await readBody(req)
    // Validate instanceName belongs to this user and is enabled
    const userInsts = await db.getUserInstances(userId)
    const requestedInstance = body.instanceName || userInstance
    const selectedInst = userInsts.find(i => i.instanceName === requestedInstance)
    if (!selectedInst || selectedInst.enabled === false) {
      json({ error: 'WhatsApp selecionado está desabilitado. Habilite antes de enviar campanha.' }, 400); return
    }
    let campaignInstance = selectedInst.instanceName
    // WA Group mode: send single message to group JID
    if (body.groupJid) {
      const media = body.useMedia ? mediaStore.get(userId) : null
      try {
        if (media) {
          await sendWhatsappMedia(body.groupJid, body.template, media, campaignInstance)
        } else {
          await sendWhatsapp(body.groupJid, body.template, campaignInstance)
        }
      } catch (e) {
        json({ error: 'Falha ao enviar para o grupo: ' + e.message }, 502); return
      }
      await db.addCampaignLog({
        id: Date.now().toString(),
        templateId: body.templateId || null,
        templateName: body.groupName || body.templateName || 'Grupo WA',
        phones: [body.groupJid],
        contacts: [{ nome: body.groupName || body.groupJid, telefone: body.groupJid }],
        sent: 1,
        failed: 0,
        sentAt: new Date().toISOString()
      }, userId).catch(() => {})
      json({ ok: true, groupMode: true }); return
    }
    const contacts = Array.isArray(body.contacts) && body.contacts.length ? body.contacts : await db.getContacts(userId)
    runCampaign(contacts, body.template, body.delayMin, body.delayMax, body.limit, body.useAI, body.useMedia ? mediaStore.get(userId) : null, body.templateId, body.templateName, userId, campaignInstance)
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

  // WA Groups
  if (url.startsWith('/api/wa-groups') && !url.includes('/sync') && !url.includes('/add') && method === 'GET') {
    const instanceName = new URL('http://x' + req.url).searchParams.get('instance') || null
    json(await db.getWaGroups(userId, instanceName)); return
  }

  if (url === '/api/wa-groups/add' && method === 'POST') {
    const body = await readBody(req)
    const instanceName = body.instanceName || userInstance
    const inviteLink = (body.inviteLink || '').trim()
    const directJid = (body.jid || '').trim()
    const customName = (body.name || '').trim()

    // Option A: JID direto
    if (directJid) {
      if (!directJid.endsWith('@g.us')) { json({ error: 'JID inválido. Formato: 120363xxx@g.us' }, 400); return }
      if (!customName) { json({ error: 'Nome do grupo obrigatório quando usar JID direto.' }, 400); return }
      await db.syncWaGroups(userId, instanceName, [{ jid: directJid, name: customName, participants: 0 }])
      json({ ok: true, jid: directJid, name: customName }); return
    }

    // Option B: link de convite → resolve via Evolution API
    const match = inviteLink.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/)
    if (!match) { json({ error: 'Informe um link de convite (https://chat.whatsapp.com/...) ou um JID direto (xxx@g.us).' }, 400); return }
    const inviteCode = match[1]
    try {
      const info = await fetchApi(`/group/inviteInfo/${instanceName}?inviteCode=${inviteCode}`, 'GET')
      const jid = info?.id || info?.jid
      const name = customName || info?.subject || info?.name || inviteCode
      if (!jid || !jid.endsWith('@g.us')) {
        json({ error: 'API não retornou JID. Tente usar o JID direto do grupo (campo alternativo).' }, 400); return
      }
      await db.syncWaGroups(userId, instanceName, [{ jid, name, participants: info?.size || 0 }])
      json({ ok: true, jid, name }); return
    } catch (e) {
      json({ error: 'Falha ao resolver link via API. Tente usar o JID direto do grupo. Detalhe: ' + e.message }, 500); return
    }
  }

  if (url.startsWith('/api/wa-groups/sync') && method === 'POST') {
    const instanceName = new URL('http://x' + req.url).searchParams.get('instance') || userInstance
    // Raw call to capture status + body for debugging
    const rawResult = await new Promise(resolve => {
      const u = new URL(API_URL + `/group/fetchAllGroups/${instanceName}?getParticipants=false`)
      const isHttps = u.protocol === 'https:'
      const transport = isHttps ? require('https') : require('http')
      const req2 = (isHttps ? require('https') : require('http')).request({
        hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search, method: 'GET',
        headers: { apikey: API_KEY, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' }
      }, res2 => {
        const chunks = []
        res2.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
        res2.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res2.statusCode, headers: res2.headers, body, bodyLen: chunks.reduce((s,c)=>s+c.length,0) })
        })
      })
      req2.setTimeout(30000, () => { req2.destroy(); resolve({ status: 0, body: 'timeout' }) })
      req2.on('error', e => resolve({ status: 0, body: e.message }))
      req2.end()
    })
    console.log(`[wa-groups sync] instance=${instanceName} status=${rawResult.status} bodyLen=${rawResult.bodyLen} headers=${JSON.stringify(rawResult.headers)} body=${rawResult.body.slice(0, 500)}`)
    if (rawResult.status === 0) { json({ error: rawResult.body }, 502); return }
    let raw
    try { raw = JSON.parse(rawResult.body) } catch { raw = null }
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.groups) ? raw.groups : [])
    if (!list.length) {
      json({ ok: true, count: 0, groups: [], debug: `status=${rawResult.status} bodyLen=${rawResult.bodyLen} enc=${rawResult.headers?.['content-encoding']||'none'} body=${rawResult.body.slice(0, 200)}` }); return
    }
    // fetchAllGroups returns only groups — all items are @g.us
    const groups = list
      .filter(g => (g.id || g.jid || '').endsWith('@g.us'))
      .map(g => ({
        jid: g.id || g.jid,
        name: g.subject || g.name || g.displayName || g.id || g.jid,
        participants: g.size || g.participants || 0
      })).filter(g => g.jid)
    await db.syncWaGroups(userId, instanceName, groups)
    json({ ok: true, count: groups.length, groups }); return
  }

  // Scheduled campaigns
  if (url === '/api/schedules' && method === 'GET') {
    json(await db.getSchedules(userId)); return
  }
  if (url === '/api/schedules' && method === 'POST') {
    const body = await readBody(req)
    if (!body.template?.trim() || !body.scheduledAt) { json({ error: 'template e scheduledAt obrigatórios' }, 400); return }
    const s = { id: Date.now().toString(), template: body.template.trim(), templateId: body.templateId || null, templateName: body.templateName || '', groupId: body.groupId || '', contactPhones: Array.isArray(body.contactPhones) ? body.contactPhones : [], scheduledAt: body.scheduledAt, delayMin: body.delayMin || 8000, delayMax: body.delayMax || 20000, dailyLimit: body.dailyLimit || 150, useAi: body.useAi || false }
    json(await db.addSchedule(s, userId)); return
  }
  if (url.startsWith('/api/schedules/') && method === 'DELETE') {
    await db.deleteSchedule(url.split('/')[3], userId)
    json({ ok: true }); return
  }

  // Vencimento rules
  if (url === '/api/vencimento-rules' && method === 'GET') {
    json(await db.getVencimentoRules(userId)); return
  }
  if (url === '/api/vencimento-rules' && method === 'POST') {
    const body = await readBody(req)
    if (!body.name?.trim() || !body.templateContent?.trim()) { json({ error: 'name e templateContent obrigatórios' }, 400); return }
    json(await db.addVencimentoRule({ id: Date.now().toString(), name: body.name.trim(), daysBefore: parseInt(body.daysBefore) || 3, templateContent: body.templateContent.trim(), templateId: body.templateId || null, templateName: body.templateName || '', groupId: body.groupId || '', contactPhones: Array.isArray(body.contactPhones) ? body.contactPhones : [], instanceName: body.instanceName || '', active: true }, userId)); return
  }
  if (url.startsWith('/api/vencimento-rules/') && method === 'PUT') {
    const body = await readBody(req)
    await db.updateVencimentoRule(url.split('/')[3], body, userId)
    json({ ok: true }); return
  }
  if (url.startsWith('/api/vencimento-rules/') && method === 'DELETE') {
    await db.deleteVencimentoRule(url.split('/')[3], userId)
    json({ ok: true }); return
  }

  // Drips
  if (url === '/api/drips' && method === 'GET') {
    json(await db.getDrips(userId)); return
  }
  if (url === '/api/drips' && method === 'POST') {
    const body = await readBody(req)
    if (!body.name?.trim()) { json({ error: 'name obrigatório' }, 400); return }
    json(await db.addDrip({ id: Date.now().toString(), name: body.name.trim(), steps: body.steps || [], active: true }, userId)); return
  }
  if (url.startsWith('/api/drips/') && !url.includes('/start') && !url.includes('/queue') && method === 'PUT') {
    const body = await readBody(req)
    await db.updateDrip(url.split('/')[3], body, userId)
    json({ ok: true }); return
  }
  if (url.startsWith('/api/drips/') && !url.includes('/start') && !url.includes('/queue') && method === 'DELETE') {
    await db.deleteDrip(url.split('/')[3], userId)
    json({ ok: true }); return
  }
  if (url.includes('/api/drips/') && url.endsWith('/queue') && method === 'GET') {
    const dripId = url.split('/')[3]
    json(await db.getDripQueue(userId, dripId)); return
  }
  if (url.includes('/api/drips/') && url.endsWith('/start') && method === 'POST') {
    const dripId = url.split('/')[3]
    const body = await readBody(req)
    const drip = await db.getDrip(dripId, userId)
    if (!drip || !drip.steps?.length) { json({ error: 'Drip sem etapas' }, 400); return }
    const userInsts = await db.getUserInstances(userId)
    const requestedInstance = body.instanceName || userInstance
    const selectedInst = userInsts.find(i => i.instanceName === requestedInstance)
    if (!selectedInst || selectedInst.enabled === false) {
      json({ error: 'WhatsApp selecionado está desabilitado. Habilite antes de iniciar a sequência.' }, 400); return
    }
    const dripInstance = selectedInst.instanceName
    let contacts = (await db.getContacts(userId)).filter(c => !c.optout)
    if (body.groupId) {
      const groups = await db.getGroups(userId)
      const grp = groups.find(g => g.id === body.groupId)
      if (grp) contacts = contacts.filter(c => phoneInGroup(grp, c.telefone))
    }
    const now = Date.now()
    const items = contacts.map((c, i) => ({
      id: `${now}_${c.telefone.replace(/\D/g, '')}_0`,
      dripId, userId,
      phone: c.telefone,
      nome: c.nome,
      instanceName: dripInstance,
      stepIndex: 0,
      sendAt: new Date(now + i * 2000).toISOString()
    }))
    await db.addDripQueueItems(items)
    json({ ok: true, enrolled: items.length }); return
  }

  // Opt-out clear
  if (url.startsWith('/api/contacts/') && url.endsWith('/optout') && method === 'DELETE') {
    const phone = decodeURIComponent(url.split('/')[3])
    await db.clearOptout(phone, userId)
    json({ ok: true }); return
  }

  // ── Instâncias WhatsApp ─────────────────────────────────────────────────────
  if (url === '/api/instances' && method === 'GET') {
    json(await db.getUserInstances(userId)); return
  }

  if (url === '/api/instances' && method === 'POST') {
    const body = await readBody(req)
    const maxInst = authUser.max_instances || 1
    const current = await db.countUserInstances(userId)
    if (current >= maxInst) { json({ error: `Limite de ${maxInst} instância${maxInst !== 1 ? 's' : ''} atingido. Contate o suporte para ampliar seu plano.` }, 400); return }
    const instanceName = userInstance + 'x' + Date.now().toString(36).slice(-4)
    await fetchApi('/instance/create', 'POST', { instanceName, qrcode: true, integration: 'WHATSAPP-BAILEYS' }).catch(() => {})
    const inst = await db.addUserInstance(userId, instanceName, body.label || `WhatsApp ${current + 1}`)
    await configureWebhookForInstance(instanceName).catch(() => {})
    json(inst); return
  }

  if (url.startsWith('/api/instances/') && method === 'PUT' && url.split('/').length === 4) {
    const instName = decodeURIComponent(url.split('/')[3])
    const body = await readBody(req)
    await db.updateUserInstanceLabel(userId, instName, body.label || '')
    json({ ok: true }); return
  }

  if (url.startsWith('/api/instances/') && url.endsWith('/enabled') && method === 'POST') {
    const instName = decodeURIComponent(url.split('/')[3])
    const body = await readBody(req)
    await db.updateUserInstanceEnabled(userId, instName, body.enabled !== false)
    json({ ok: true, enabled: body.enabled !== false }); return
  }

  if (url.startsWith('/api/instances/') && method === 'DELETE' && url.split('/').length === 4) {
    const instName = decodeURIComponent(url.split('/')[3])
    const instances = await db.getUserInstances(userId)
    if (instances.length <= 1) { json({ error: 'Não é possível remover a única instância.' }, 400); return }
    await fetchApi(`/instance/delete/${instName}`, 'DELETE').catch(() => {})
    await db.deleteUserInstance(userId, instName)
    json({ ok: true }); return
  }

  if (url.startsWith('/api/instances/') && url.endsWith('/connect') && method === 'POST') {
    const instName = decodeURIComponent(url.split('/')[3])
    try {
      await fetchApi('/instance/create', 'POST', { instanceName: instName, qrcode: true, integration: 'WHATSAPP-BAILEYS' }).catch(() => {})
      configureWebhookForInstance(instName).catch(() => {})
      json({ ok: true }); return
    } catch (e) { json({ error: e.message }, 500); return }
  }

  if (url.startsWith('/api/instances/') && url.endsWith('/qr') && method === 'GET') {
    const instName = decodeURIComponent(url.split('/')[3])
    try {
      const result = await fetchApi(`/instance/connect/${instName}`, 'GET').catch(() => ({}))
      json({ base64: result.qrcode?.base64 || result.base64 || null }); return
    } catch (e) { json({ base64: null }); return }
  }

  if (url.startsWith('/api/instances/') && url.endsWith('/disconnect') && method === 'POST') {
    const instName = decodeURIComponent(url.split('/')[3])
    await fetchApi(`/instance/logout/${instName}`, 'DELETE').catch(() => {})
    json({ ok: true }); return
  }

  if (url.startsWith('/api/instances/') && url.endsWith('/status') && method === 'GET') {
    const instName = decodeURIComponent(url.split('/')[3])
    try { json(await fetchApi(`/instance/connectionState/${instName}`, 'GET')) }
    catch (e) { json({ instance: { state: 'close' } }) }
    return
  }

  if (url === '/api/reconfigure-webhooks' && method === 'POST') {
    const instances = await db.getUserInstances(userId)
    const results = []
    for (const inst of instances) {
      if (inst.enabled === false) { results.push({ instance: inst.instanceName, skipped: true }); continue }
      try {
        await configureWebhookForInstance(inst.instanceName)
        results.push({ instance: inst.instanceName, ok: true })
      } catch (e) {
        results.push({ instance: inst.instanceName, ok: false, error: e.message })
      }
    }
    json({ results }); return
  }

  if (url === '/api/webhook-diagnostics' && method === 'GET') {
    const instances = await db.getUserInstances(userId)
    const diag = []
    for (const inst of instances) {
      const wh = await fetchApi(`/webhook/find/${inst.instanceName}`, 'GET').catch(e => ({ error: e.message }))
      const st = await fetchApi(`/instance/connectionState/${inst.instanceName}`, 'GET').catch(() => ({}))
      diag.push({ instance: inst.instanceName, state: st?.instance?.state, webhook: wh })
    }
    const rules = await db.getAutoreplies(userId)
    const baseUrl = process.env.WEBHOOK_BASE_URL || `http://host.docker.internal:${PORT}`
    json({ diag, rules: rules.map(r => ({ id: r.id, name: r.name, trigger: r.trigger, keywords: r.keywords, active: r.active })), expectedWebhookUrl: baseUrl + '/webhook' }); return
  }

  // Admin routes
  if (url.startsWith('/api/admin/') && !isAdmin) {
    json({ error: 'Acesso negado' }, 403); return
  }

  if (url === '/api/admin/test-notify' && method === 'POST') {
    if (!process.env.ADMIN_PHONE) { json({ error: 'ADMIN_PHONE não configurado no Railway' }, 400); return }
    try {
      await notifyAdminNewUser('Teste Manual', 'teste@exemplo.com', '11999999999')
      json({ ok: true, msg: 'WhatsApp enviado para ' + process.env.ADMIN_PHONE }); return
    } catch (e) {
      json({ error: e.message }, 500); return
    }
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
    if (body.max_instances !== undefined) updates.max_instances = Math.min(5, Math.max(1, parseInt(body.max_instances) || 1))
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
  } // end handleRequest

  handleRequest().catch(e => {
    console.error('[HTTP] Unhandled error:', e.message)
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Internal server error' })) }
  })
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

server.listen(PORT, () => {
  console.log(`\n⚡ ZapVibe Dashboard → http://localhost:${PORT}\n`)
  console.log(`🔔 Notify novo cadastro: ${process.env.ADMIN_PHONE ? 'WhatsApp → ' + process.env.ADMIN_PHONE : 'NÃO CONFIGURADO (ADMIN_PHONE ausente)'}`)
  if (process.platform === 'win32') exec(`start "" "http://localhost:${PORT}"`)
})

db.init().then(seedAdmin).then(() => {
  console.log('✔ Banco de dados pronto')
  setTimeout(configureWebhook, 3000)
}).catch(err => {
  console.error('Erro ao iniciar banco de dados:', err.message)
  process.exit(1)
})
