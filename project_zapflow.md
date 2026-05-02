---
name: ZapFlow Project Overview
description: WhatsApp mass-messaging SaaS (ZapVibe) — stack, arquitetura multi-tenant, todas as features implementadas
type: project
originSessionId: bd30527a-e940-4016-9aa7-1020f72b4a80
---
ZapVibe é um SaaS de disparos inteligentes via WhatsApp com IA, multi-tenant, dashboard web, auto-respostas, agendamento, drip, e analytics.

**Why:** Ferramenta de marketing via WhatsApp para disparos em massa com personalização por IA, vendida como SaaS com trial de 7 dias.

**How to apply:** Arquitetura single-file (src/dashboard.js ~3700 linhas). Banco Supabase PostgreSQL via pg. Deploy Railway. Toda feature nova segue padrão multi-tenant: userId FK em todas as tabelas, rotas protegidas por auth guard.

## Stack
- **Backend:** Node.js HTTP nativo (sem framework), porta via `process.env.PORT || 3000`
- **WhatsApp Gateway:** Evolution API v1.8.7 — serviço separado Railway (`evolution-api-production-4f3a.up.railway.app`)
- **IA:** Groq SDK — llama-3.1-8b-instant
- **Frontend:** SPA HTML puro + Tailwind CSS CDN (embedded em getAppHTML() no dashboard.js)
- **Banco:** PostgreSQL — Supabase (session pooler SSL). Pool via `pg`
- **Deploy:** Railway (railway.toml + Dockerfile). `startCommand = "node src/dashboard.js"`
- **Auth:** session-based, `crypto.scrypt` para senhas, `crypto.randomBytes` para tokens, HttpOnly cookies

## Arquivos principais
- `src/dashboard.js` — ~3700 linhas. Servidor HTTP, SPA HTML (getAppHTML/getAdminHTML/LANDING_HTML/REGISTER_HTML/LOGIN_HTML), todas as rotas API, lógica de campanha, webhook, crons
- `src/db.js` — ~830 linhas. Pool pg, init() com CREATE TABLE + ALTER TABLE (safe migrations), todas as funções CRUD por userId
- `src/migrate.js` — script one-shot para migrar dados antigos de CSV/JSON para Supabase
- `.env` — EVOLUTION_API_URL, EVOLUTION_API_KEY, GROQ_API_KEY, DATABASE_URL, WEBHOOK_BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_PHONE, DELAY_MIN/MAX, DAILY_LIMIT, USE_AI
- `railway.toml` — builder DOCKERFILE, healthcheckPath "/", timeout 30s. **Importante:** server.listen() ANTES de db.init() para healthcheck passar

## Multi-tenant
- Cada usuário tem `instance_name = 'zv' + id` na Evolution API (instância primária)
- Instâncias adicionais: `zv{userId}x{Date.now().toString(36).slice(-4)}`
- `campaigns` Map e `mediaStore` Map keyed by userId no server
- Webhook resolve `data.instance` → `getUserByInstance` (JOIN em users + user_instances) → userId
- Auth guard lê userId de sessão antes de qualquer rota /api/

## Banco de dados — tabelas
| Tabela | Descrição |
|---|---|
| users | id, email, password_hash, role, status, instance_name, name, phone, trial_ends_at, max_instances |
| sessions | token, email, expires_at |
| contacts | id, user_id, nome, telefone, empresa, extra, vencimento, optout |
| templates | id, user_id, name, content, media_type, media_data, media_name, media_mimetype |
| autoreplies | id, user_id, name, trigger, keywords, response, delay, active, media_*, template_id |
| campaign_log | id, user_id, template_id, template_name, phones, contacts_data, sent, failed, responses, sent_at |
| groups_table | id, user_id, name, phones[] |
| lid_map | lid, jid, user_id |
| draft | user_id PK, content |
| scheduled_campaigns | id, user_id, template, group_id, scheduled_at, delay_min/max, daily_limit, use_ai, status |
| vencimento_rules | id, user_id, name, days_before, template_content, active, last_run_date |
| drips | id, user_id, name, steps JSONB, active |
| drip_queue | id, drip_id, user_id, phone, nome, step_index, send_at, status |
| campaign_responses | (campaign_log_id, phone) PK, user_id, responded_at |
| user_instances | id, user_id, instance_name UNIQUE, label, created_at |
| wa_groups | id, user_id, instance_name, jid, name, participants, synced_at — UNIQUE(user_id, jid) |

## Funcionalidades implementadas

### Core
1. **Conexão** — status em tempo real, QR code inline, conectar/desconectar
2. **Contatos** — CRUD, busca, import/export CSV, filtro por grupo, ordem alfabética
3. **Campanha** — templates com {nome}/{empresa}/{extra}/{vencimento}, IA Groq, mídia (imagem/vídeo/áudio/PDF), progresso real-time, stop, log
4. **Auto-respostas** — webhook MESSAGES_UPSERT, anti-loop 5min, resolução @lid, regras por keywords/any, filtro por campanha/template
5. **Histórico** — anti-spam por contato (cor por dias), campanhas expansíveis

### SaaS / Multi-tenant
6. **Auth** — login, sessões 7 dias, scrypt hash, cookie HttpOnly
7. **Landing page** — SEO + CTA + Open Graph + JSON-LD + schema.org. Seções: hero, stats, features, como funciona, depoimentos, preços, CTA final
8. **Auto-registro** — form (nome/email/telefone/senha), status pending inicial
9. **Trial** — `trial_ends_at` por usuário, tela de expiração com link suporte
10. **Admin panel** — lista usuários, ativa/desativa, configura dias trial (7/15/30/custom), cria usuários
11. **Supabase keep-alive** — rota `/ping` + UptimeRobot a cada 5min para evitar sleep

### UX / Contatos
12. **Grupos de contatos** — criar, editar, deletar grupos; atribuir contatos; filtrar por grupo na campanha
13. **Novo contato** — form inline com seletor de grupo + criação de grupo inline
14. **CSV import melhorado** — auto-detect delimitador (;/,), normaliza headers, scientific notation phones, strip BOM, deduplica por telefone (upsert), preserva optout no reimporte

### Campanhas avançadas
15. **Remarketing** — botão ↩ no histórico, `window._remarketingContacts`, banner âmbar
16. **Opt-out** — detecta "sair/parar/stop/cancelar/remover" → marca `optout=true` → confirmação → bloqueia em campanhas; badge "SAIU"; botão ↩ para reincluir
17. **Agendamento** — toggle na aba Campanha → datetime picker → salva em `scheduled_campaigns` → cron 60s dispara na hora certa
18. **Automação por vencimento** — regras (X dias antes do campo vencimento) → cron 1h verifica data match → dispara automaticamente
19. **Drip campaigns** — sequências multi-etapa com delay em dias; cron 60s processa fila; start por grupo
20. **Analytics de resposta** — webhook rastreia replies pós-campanha (1x por contato por campanha) → `responses` count → histórico mostra `💬 X respostas (Y%)`

### Funcionalidades (2026-04-30)
21. **Mídia em templates** — templates salvam mídia no banco (image/video/audio/PDF). Limites: imagem 5MB, áudio/PDF 10MB, vídeo 15MB.
    - 4 colunas em `templates`: `media_type`, `media_data`, `media_name`, `media_mimetype`
    - `getTemplateById` retorna media_data completo; `getTemplates` retorna só metadata (performance)
    - Frontend: `_currentMedia` global rastreia mídia da sessão

22. **Notificação WhatsApp ao admin** — quando novo usuário se cadastra, envia WhatsApp para `ADMIN_PHONE` via instância principal do admin (`sendWhatsapp`).
    - Env var: `ADMIN_PHONE` (DDI+DDD+número, só dígitos)
    - Rota de teste: `POST /api/admin/test-notify`
    - Railway bloqueia SMTP → por isso WhatsApp em vez de email

23. **Multi-instância** — cada usuário pode ter até N contas WhatsApp (N controlado pelo admin via `max_instances`)
    - Tabela `user_instances` rastreia todas as instâncias
    - Migration automática no `db.init()` copia instâncias existentes para `user_instances`
    - Aba Conexão: cards por instância + modal QR centralizado
    - Aba Campanha: seletor "Disparar de qual WhatsApp" popula via `loadInstances()`
    - Admin panel: dropdown 1-5 instâncias por usuário

### Funcionalidades (2026-05-01)
24. **Grupos do WhatsApp (WA Groups)** — capturar grupos das contas WA conectadas e enviar campanhas para eles
    - Tabela `wa_groups`: user_id, instance_name, jid, name, participants, UNIQUE(user_id, jid)
    - `getWaGroups(userId, instanceName)` e `syncWaGroups(userId, instanceName, groups)` em db.js
    - `GET /api/wa-groups?instance=xxx` — lista grupos do DB
    - `POST /api/wa-groups/sync?instance=xxx` — tenta busca na Evolution API (retorna vazio — bug v1.8.7)
    - Aba Conexão: botão **👥 Grupos** em cada card de instância
    - Aba Campanha: toggle "Enviar para grupo do WhatsApp" → dropdown de grupos → envia mensagem única para o JID do grupo
    - `/api/campaign/start` suporta `body.groupJid` — envia direto para o grupo, bypassa loop de contatos
    - Frontend: `syncWaGroups()`, `loadWaGroups()`, `toggleWaGroupMode()`, `reloadWaGroups()`
    - **Auto-captura via MESSAGES_UPSERT:** mensagens recebidas de grupo (`@g.us`) → salva no wa_groups automaticamente
    - **NOTA:** GROUPS_UPSERT removido do array de eventos do webhook (Evolution API v1.8.7 rejeita → quebra MESSAGES_UPSERT)

25. **Favicon** — ícone roxo escuro + raio violeta em todas as páginas (Landing, Login, Register, Admin, App)
    - SVG inline via data URI: `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,...">`
    - Cor fundo: `#1E1B4B` (roxo escuro), raio: `#8B5CF6` (violeta)

## Tabs da SPA
1. 📱 Conexão (multi-instância: cards + QR modal + botão 👥 Grupos por instância)
2. 👥 Contatos
3. 📤 Campanha (+ seletor de instância + toggle WA group mode + agendamento inline)
4. 🤖 Respostas (auto-respostas)
5. ⚡ Automações (vencimento rules + drips + campanhas agendadas)
6. 📊 Histórico (com taxa de resposta)

## Detalhes técnicos importantes

### fetchApi (dashboard.js ~linha 314)
```javascript
function fetchApi(urlPath, method, body, timeoutMs = 15000)
```
- **IMPORTANTE:** usa `u.pathname + u.search` (corrigido — antes só `u.pathname` dropava query string)
- Timeout padrão 15s; wa-groups sync usa 30s
- Resolve com `{}` se JSON.parse falhar

### Roteamento (dashboard.js)
- `const url = req.url` — inclui query string
- Rotas com query params devem usar `url.startsWith(...)` não `url === ...`
- Ex: `GET /api/wa-groups?instance=zv1` → use `url.startsWith('/api/wa-groups') && !url.includes('/sync')`

### Template literals em getAppHTML()
- Toda a SPA está dentro de template literal backtick em `getAppHTML()`
- JS inline na SPA: backticks internos DEVEM ser escapados: `` \` `` e `\${}`
- Não escapar = erro de sintaxe que quebra a página

### Notificação admin
- `notifyAdminNewUser(name, email, phone)` — fire-and-forget via WhatsApp
- Usa `ADMIN_PHONE` env var (DDI+DDD+número)
- Railway bloqueia SMTP (portas 465/587) — confirmado por timeout

### Banco — safe migrations
- Todas as colunas novas via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` em bloco `.catch(() => {})`
- Tabelas novas via `CREATE TABLE IF NOT EXISTS` no bloco principal

## Problema @lid (WhatsApp multi-device)
WhatsApp usa JIDs como `167516643029216@lid`. Evolution API rejeita envio direto.
Solução: cache lid_map → match nome CSV → consulta Evolution API contacts → tenta @lid direto.

## `formatPhone` (dashboard.js ~linha 305)
- Se phone contém `@` → passa direto (JID completo, incluindo `@g.us` para grupos)
- Senão → normaliza para número BR com DDI 55

## Limites anti-ban
- Max 150 msgs/dia, delay 8-20s, cooldown auto-resposta 5min
- Opt-out automático remove contato da lista permanentemente

## Deploy (Railway)
- Push para `main` → Railway detecta → build Dockerfile → deploy automático (~1-2 min)
- `server.listen(PORT)` PRIMEIRO, depois `db.init()` em background (healthcheck passa sem esperar DB)
- URL produção: https://zapvibe-production.up.railway.app
- GitHub: https://github.com/fabinholemos/zapvibe
- Evolution API: serviço separado Railway (`evolution-api-production-4f3a.up.railway.app`)
- Volume persistente montado em `/evolution/instances` no serviço evolution-api

## Variáveis de ambiente (Railway — serviço zapvibe)
- `EVOLUTION_API_URL=https://evolution-api-production-4f3a.up.railway.app`
- `EVOLUTION_API_KEY=zapvibe-secret-key-2024`
- `WEBHOOK_BASE_URL=https://zapvibe-production.up.railway.app`

## Webhook
- `configureWebhookForInstance` usa `WEBHOOK_BASE_URL || http://localhost:${PORT}`
- Reconfigura automaticamente: no startup (`configureWebhook()`), ao conectar instância, ao abrir aba Respostas
- `POST /api/reconfigure-webhooks` — força reconfiguração manual
- `GET /api/webhook-diagnostics` — debug: mostra config atual + regras ativas

## WA Groups — STATUS
- `fetchAllGroups` e `findChats` retornam vazio (bug Evolution API v1.8.7 — body 0 bytes ou `[]`)
- **GROUPS_UPSERT removido** dos eventos do webhook — Evolution API v1.8.7 rejeita evento → quebra MESSAGES_UPSERT inteiro
- Auto-captura via `MESSAGES_UPSERT` quando JID termina em `@g.us` → salva no `wa_groups`
- Grupos aparecem automaticamente quando mensagem chega de um grupo

## Auto-respostas — filtro de campanha
- Regra sem campanha (`templateId=null`): dispara para qualquer remetente
- Regra com campanha: dispara APENAS para quem recebeu aquela campanha (`senderTemplateId === r.templateId`)
- Remetente sem histórico de campanha (`senderTemplateId === null`): **pula** regras de campanha (só genéricas)
- Bug anterior: `senderTemplateId === null → return true` incluía TODAS as regras — corrigido para `return false`

## Evolution API — Railway
- Serviço separado: `evolution-api-production-4f3a.up.railway.app`
- Volume persistente: `/evolution/instances` (Railway persistent volume) — mantém sessões WA entre deploys
- Webhook configurado automaticamente em: startup, connect, aba Respostas open
- `POST /api/reconfigure-webhooks` — força reconfiguração manual
- `GET /api/webhook-diagnostics` — debug: config atual + regras ativas + URL esperada

## Webhook — detalhe crítico
- Evolution API v1.8.7: array `events` deve conter APENAS eventos válidos
- Evento inválido (ex: `GROUPS_UPSERT`) → API rejeita config inteira → MESSAGES_UPSERT para de funcionar
- Solução: array contém só `['MESSAGES_UPSERT']`

## Commits recentes (2026-05-01)
- `36b5358` feat: add favicon (purple+lightning) to all pages
- `4c7ca02` fix: campaign-specific autoreplies only fire for senders from that campaign
- `ef8bc07` fix: webhook URL use localhost, add enabled+base64 fields
- `5b60e56` debug: add /api/webhook-diagnostics endpoint
- `20473d5` fix: revert processWebhook to original, auto-reconfigure webhook on Respostas tab open
- `a58bbb6` fix: remove GROUPS_UPSERT from webhook events (breaks MESSAGES_UPSERT in Evo API v1)
- `9c70604` fix: reconfigure webhook after instance/create
- `6fc728a` feat: auto-discover WA groups from incoming group messages via webhook
