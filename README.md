# ZapVibe — Plataforma de Marketing via WhatsApp com IA

SaaS multi-tenant para disparos em massa, automação de respostas e campanhas inteligentes via WhatsApp.

## Stack

| Camada | Tecnologia |
|---|---|
| Backend | Node.js HTTP nativo (~3700 linhas, `src/dashboard.js`) |
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
- **Auto-respostas** — webhook MESSAGES_UPSERT, keywords configuráveis, filtro por campanha, anti-loop 5min
- **Histórico** — log de campanhas, taxa de resposta, anti-spam por contato

### Automações
- **Agendamento** — envio em data/hora específica
- **Vencimento** — dispara X dias antes do campo vencimento do contato
- **Drip campaigns** — sequências multi-etapa com delay em dias

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
┌─────────────────────┐        ┌────────────────────────┐
│  src/dashboard.js   │◄──────►│  Evolution API v1.8.7  │
│  (HTTP server +     │        │  (Baileys/WhatsApp)     │
│   SPA + API routes) │        │  /evolution/instances  │
└────────┬────────────┘        │  (volume persistente)  │
         │                     └────────────────────────┘
         ▼
┌─────────────────────┐
│  src/db.js          │
│  (Supabase/pg pool) │
└─────────────────────┘
```

Cada usuário tem instância própria na Evolution API: `zv{userId}` (primária) + `zv{userId}x{sufixo}` (adicionais).

## Deploy (Railway)

URL produção: `https://zapvibe-production.up.railway.app`

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
WEBHOOK_BASE_URL=https://zapvibe-production.up.railway.app

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

Migrations seguras: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — sem downtime.

## Desenvolvimento local

```bash
npm install
cp .env.example .env   # configure as variáveis
node src/dashboard.js  # http://localhost:3000
```

Requer Evolution API rodando (Docker ou Railway).

## Estrutura

```
zapflow/
  src/
    dashboard.js   — servidor HTTP, SPA, todas as rotas API, crons, webhook
    db.js          — pool pg, init(), todas as funções CRUD
    migrate.js     — script one-shot (migração de dados legados)
  railway.toml
  Dockerfile
  package.json
  .env
```

## GitHub

https://github.com/fabinholemos/zapvibe
