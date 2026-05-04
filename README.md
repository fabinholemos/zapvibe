# ZapVibe — Plataforma de Marketing via WhatsApp com IA

SaaS multi-tenant para disparos em massa, automação de respostas e campanhas inteligentes via WhatsApp.

## Stack

| Camada | Tecnologia |
|---|---|
| Backend | Node.js HTTP nativo (modular: `dashboard.js` + 5 módulos) |
| Frontend | SPA HTML puro + Tailwind CSS CDN (embutido no backend) |
| Banco | PostgreSQL via Supabase (session pooler SSL, pool `pg`) |
| WhatsApp | Evolution API v1.8.7 (serviço separado no Railway) |
| IA | Groq SDK — llama-3.1-8b-instant |
| Auth | Sessions 7 dias, scrypt hash, cookie HttpOnly |
| Deploy | Railway — dois serviços: `zapvibe` + `evolution-api` |

## Funcionalidades

### Core
- **Conexão** — QR code inline, status em tempo real, multi-instância (N contas WA por usuário)
- **Contatos** — CRUD, import/export CSV, grupos, busca, opt-out automático
- **Campanhas** — templates com `{nome}`, `{empresa}`, `{extra}`, `{vencimento}` + personalização por IA Groq
- **Mídia** — imagem (5MB), vídeo (15MB), áudio/PDF (10MB) nos templates
- **Auto-respostas** — webhook MESSAGES_UPSERT, keywords configuráveis, filtro por campanha e por instância WA, agendamento por horário/dias, off-hours msg, follow-up steps, anti-loop 5min
- **Histórico** — log de campanhas, taxa de resposta, anti-spam por contato

### Automações
- **Agendamento** — envio em data/hora específica
- **Vencimento** — dispara X dias antes do campo vencimento do contato
- **Drip campaigns** — sequências multi-etapa com delay em dias
- **Follow-up automático** — após auto-resposta, enfileira mensagens de follow-up com delay em horas (tabela `autoreply_followup_queue`)

### SaaS / Multi-tenant
- **Auth** — login, registro, trial 7 dias, tela de expiração
- **Admin panel** — ativa/desativa usuários, configura trial, cria usuários
- **Multi-instância** — cada usuário tem N contas WA (admin define limite)
- **Landing page** — SEO, Open Graph, JSON-LD, schema.org

### Proteção anti-ban
- Delay aleatório 8–20s entre mensagens
- Limite 150 msgs/dia por padrão
- Opt-out automático (detecta "sair/parar/stop/cancelar")
- Cooldown 5min por contato nas auto-respostas

## Arquitetura

```
zapvibe (Railway)              evolution-api (Railway)
┌──────────────────────────┐   ┌────────────────────────┐
│  src/dashboard.js        │◄─►│  Evolution API v1.8.7  │
│  (HTTP server, rotas,    │   │  (Baileys/WhatsApp)     │
│   HTML/SPA)              │   │  /evolution/instances  │
│                          │   │  (volume persistente)  │
│  src/auth.js             │   └────────────────────────┘
│  src/whatsapp.js         │
│  src/campaign.js         │
│  src/webhook.js          │
│  src/crons.js            │
└────────┬─────────────────┘
         ▼
┌─────────────────────┐
│  src/db.js          │
│  (Supabase/pg pool) │
└─────────────────────┘
```

Cada usuário tem instância própria na Evolution API: `zv{userId}` (primária) + `zv{userId}x{sufixo}` (adicionais).

## Deploy (Railway)

URL produção: `https://www.zapvibe.com.br`

```
railway.toml
  builder: DOCKERFILE
  startCommand: node src/dashboard.js
  healthcheckPath: /
```

**Importante:** `server.listen()` é chamado ANTES de `db.init()` para o healthcheck do Railway passar.

## Variáveis de ambiente

```env
# Banco
DATABASE_URL=postgresql://...supabase.com:6543/postgres?sslmode=require

# Evolution API
EVOLUTION_API_URL=https://evolution-api-production-4f3a.up.railway.app
EVOLUTION_API_KEY=sua-chave-aqui

# Webhook (URL pública do zapvibe)
WEBHOOK_BASE_URL=https://www.zapvibe.com.br

# IA
GROQ_API_KEY=sua-chave-groq

# Admin
ADMIN_EMAIL=admin@exemplo.com
ADMIN_PASSWORD=senha-segura
ADMIN_PHONE=5511999999999

# Limites (opcionais)
DELAY_MIN=8000
DELAY_MAX=20000
DAILY_LIMIT=150
USE_AI=true
```

## Banco de dados

Tabelas principais (criadas automaticamente via `db.init()`):

| Tabela | Descrição |
|---|---|
| `users` | Usuários, roles, trial, instâncias |
| `sessions` | Tokens de sessão |
| `contacts` | Contatos por usuário (nome, telefone, empresa, opt-out) |
| `templates` | Templates com mídia (base64 no banco) |
| `autoreplies` | Regras de auto-resposta |
| `campaign_log` | Histórico de campanhas |
| `scheduled_campaigns` | Campanhas agendadas |
| `vencimento_rules` | Automação por vencimento |
| `drips` / `drip_queue` | Drip campaigns |
| `wa_groups` | Grupos do WhatsApp capturados via webhook |
| `user_instances` | Instâncias WA por usuário |
| `groups_table` | Grupos de contatos |
| `autoreply_followup_queue` | Fila de follow-ups hora-based pós auto-resposta |

Migrations seguras: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — sem downtime.

## Desenvolvimento local

```bash
npm install
cp .env.example .env   # configure as variáveis
npm run dashboard     # http://localhost:3000
```

Requer Evolution API rodando (Docker ou Railway).

## Estrutura

```
zapflow/
  src/
    dashboard.js   — servidor HTTP, rotas API, HTML/SPA, constantes
    auth.js        — hashPassword, verifyPassword, sessions, cookies
    whatsapp.js    — fetchApi, sendWhatsapp, sendWhatsappMedia, applyTemplate, IA
    campaign.js    — runCampaign, campaigns Map (estado por userId)
    webhook.js     — processWebhook, configureWebhook, resolveJidForSending
    crons.js       — checkSchedules, checkVencimentos, checkDrips, checkFollowups (setIntervals)
    db.js          — pool pg, init(), todas as funções CRUD
    migrate.js     — script one-shot (migração de dados legados)
  railway.toml
  Dockerfile
  package.json
  .env
```

## Atualizações operacionais recentes

### Domínio e Railway
- Domínio de produção configurado como `https://www.zapvibe.com.br`.
- DNS configurado no Registro.br usando registros solicitados pelo Railway para `www.zapvibe.com.br`.
- Variável `WEBHOOK_BASE_URL` deve apontar para `https://www.zapvibe.com.br`, para a Evolution API registrar webhooks em `/webhook` no domínio público.
- O serviço `zapvibe` no Railway usa `node src/dashboard.js` como start command; o servidor sobe antes de `db.init()` para evitar falha no healthcheck durante inicialização.

### Multi-instância WhatsApp
- Cada usuário pode ter múltiplas contas WhatsApp, conforme limite `max_instances` definido pelo admin.
- A aba Conexão possui `QR / Conectar`, `Desconectar`, remover instância e `Habilitar/Desabilitar`.
- Desabilitar uma instância não remove nem desconecta a conta da Evolution API; apenas impede que o ZapVibe use essa instância em campanhas, respostas automáticas e processamento de webhook.
- Instâncias desabilitadas ficam fora dos seletores de Campanha e Auto-respostas.
- Campanhas são bloqueadas se o WhatsApp selecionado estiver desabilitado.

### Diagnóstico resolvido: dois Zaps ligados no teste
- Problema encontrado: ao testar com dois números próprios conectados no ZapVibe, a Evolution enviava eventos dos dois lados da conversa. A resposta `quero` podia chegar em uma instância como `fromMe=true`, sendo ignorada corretamente pelo sistema.
- Solução operacional: manter habilitado apenas o WhatsApp que dispara a campanha e desabilitar no ZapVibe o número usado como cliente/teste.
- Solução técnica: a deduplicação do webhook passou a usar `instanceName + messageId`, evitando que um evento de uma instância bloqueie o evento válido de outra.

### Auto-respostas e proteção anti-loop
- Mensagens enviadas por campanhas e auto-respostas são lembradas temporariamente para ignorar ecos do webhook.
- O cache anti-eco compara por telefone e também por texto normalizado, cobrindo casos em que a Evolution troca o JID/número no evento.
- Auto-respostas enviadas também entram no cache para evitar que a própria resposta seja processada como nova entrada.
- Logs do webhook foram ampliados para diagnosticar retornos silenciosos como `fromMe`, payload sem `data`, mensagem sem `remoteJid` e duplicidade.

### Seleção de instância em campanhas e respostas
- Campanhas validam se a instância selecionada pertence ao usuário e está habilitada.
- Regras de auto-resposta associadas a uma campanha seguem primeiro o `templateId`/campanha, evitando bloqueio indevido quando a instância amigável escolhida na UI difere do `instanceName` do webhook.
- Regras globais do tipo `any` continuam restritas a conversas orgânicas, para não interferir em respostas de campanhas.

## GitHub

https://github.com/fabinholemos/zapvibe
