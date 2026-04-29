# ZapFlow — Documentação Completa

> Disparador inteligente de WhatsApp com IA, dashboard web, auto-respostas, grupos e histórico anti-spam.

---

## Stack

| Componente | Tecnologia |
|---|---|
| Backend | Node.js (sem framework, HTTP nativo) |
| WhatsApp Gateway | Evolution API v1.8.7 (Docker) |
| IA | Groq SDK — modelo `llama-3.1-8b-instant` |
| Frontend | SPA em HTML puro + Tailwind CSS CDN |
| Dados | CSV + JSON em `data/` (sem banco de dados) |
| Porta | `http://localhost:3000` |

---

## Arquitetura

```
zapflow/
├── src/
│   ├── dashboard.js      # servidor HTTP + SPA + webhook + toda lógica
│   └── whatsapp.js       # utilitário de conexão (CLI)
├── data/
│   ├── contatos.csv      # contatos (nome, telefone, empresa, extra)
│   ├── templates.json    # templates de mensagem salvos
│   ├── autoreplies.json  # regras de auto-resposta
│   ├── campaign_log.json # histórico de campanhas enviadas
│   ├── groups.json       # grupos de contatos
│   └── lid_map.json      # cache @lid → JID real (WhatsApp privacy)
├── .env                  # chaves e configurações
├── docker-compose.yml    # Evolution API v1.8.7
└── RESUMO.md
```

### Fluxo de dados

```
Browser (SPA) ←→ dashboard.js (porta 3000)
                      ↕
               Evolution API (porta 8080, Docker)
                      ↕
                  WhatsApp (Baileys)
                      ↓
              Webhook → dashboard.js → processWebhook()
                                           ↓
                                    Auto-resposta enviada
```

---

## Configuração (.env)

```env
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=zapflow-secret-key-mude-isso
INSTANCE_NAME=minha-empresa
GROQ_API_KEY=sua_chave_groq
USE_AI=true
DELAY_MIN=8000
DELAY_MAX=20000
DAILY_LIMIT=150
```

---

## Funcionalidades por Aba

### 📱 Conexão

- Status em tempo real da instância WhatsApp (polling a cada 8s)
- Gera QR Code — exibido inline no dashboard
- Botões Conectar / Desconectar
- Indicador de status global no header

---

### 👥 Contatos

#### Gestão de contatos
- Tabela com Nome, Telefone, Empresa, Extra
- **Adicionar** contato manualmente (formulário inline)
- **Editar** contato (botão ✎ → modal pré-preenchido)
- **Excluir** individual (botão ✕)
- **Excluir em massa** — selecionar vários → botão vermelho aparece
- Busca em tempo real (nome, telefone, empresa)
- **Importar CSV** — valida telefone (10–13 dígitos), ignora inválidos
- **Exportar CSV** — download direto pelo browser

#### Grupos de contatos
- Chips de grupo acima da tabela — clica → filtra contatos do grupo
- **Criar grupo** (nome livre, salvo em `groups.json`)
- **Excluir grupo** (✕ no chip — contatos não são afetados)
- Selecionar contatos → botão "📂 Adicionar ao grupo" aparece
- Grupos usados como filtro na aba Campanha

---

### 📤 Campanha

#### Template de mensagem
- Editor textarea com variáveis: `{nome}`, `{empresa}`, `{extra}`
- Botões de inserção rápida de variáveis
- **Salvar rascunho** (persiste em `data/template.txt`)
- **Salvar como novo template** (modal com nome → `templates.json`)
- **Templates salvos** — listar, carregar, atualizar, excluir

#### Personalização com IA
- Checkbox "Personalizar com IA" — usa Groq llama-3.1-8b-instant
- IA reescreve mensagem preservando conteúdo + formatação WhatsApp (`*negrito*`, `_itálico_`)
- Fallback: `applyTemplate()` se IA falhar ou não configurada
- max_tokens: 600

#### Mídia (opcional)
- Upload de imagem, vídeo, áudio ou PDF
- Preview inline (imagem, vídeo, áudio, ícone de documento)
- Texto da mensagem vira legenda da mídia
- Botão remover mídia

#### Disparar campanha
- **Seletor de grupo** — dropdown: "Todos os contatos" ou grupo específico
  - Selecionar grupo → marca automaticamente os contatos daquele grupo
- Configurações: delay mínimo, delay máximo (ms), limite diário
- Selecionar contatos individualmente via checkboxes na aba Contatos
- Confirmação antes de disparar (mostra quantidade e label)
- **Progresso em tempo real** — barra, contador, % completo
- **Log em tempo real** — cada envio, erro, delay
- **Stop** — para campanha no próximo ciclo
- **Resultados** — tabela final com status e horário por contato
- Delay aleatório entre envios (anti-spam)

---

### 🤖 Auto-respostas

#### Como funciona
- Evolution API envia webhook `messages.upsert` → `processWebhook()`
- Anti-loop: cooldown de 5 minutos por número
- Ignora grupos e mensagens enviadas pelo próprio ZapFlow (`fromMe: true`)
- Resolução automática de JIDs `@lid` (formato de privacidade do WhatsApp)
  - Cache em `lid_map.json`
  - Fallback: match por `pushName` nos contatos CSV
  - Fallback: consulta à Evolution API (`/contact/findContacts`)

#### Regras de auto-resposta
Cada regra tem:
- **Nome** (identificação)
- **Campanha associada** (filtro: responde só pra quem recebeu aquele template)
  - Se "Global" → responde todos
- **Gatilho**: palavras-chave ou qualquer mensagem
  - Palavras-chave: separadas por linha, vírgula ou `/` — match case-insensitive
- **Mensagem de resposta** — suporta `{nome}`, `{empresa}`, `{extra}` (busca no CSV pelo telefone)
- **Mídia** — arquivo opcional junto com a resposta
- **Delay** antes de responder (ms)
- **Ativa/Inativa**

#### Ordem de execução
Primeira regra que bater é executada. Regras com palavras-chave devem vir antes de "qualquer mensagem".

---

### 📊 Histórico

#### Anti-spam por contato
- Lista todos os contatos que receberam mensagem
- Mostra há quantos dias recebeu + qual campanha
- Código de cor: 🟢 >3 dias | 🟡 <3 dias | 🔴 hoje

#### Campanhas enviadas
- Data/hora, nome da campanha, enviadas ✔ e falhas ✘
- "Ver contatos" expansível — lista nome e telefone de cada contato atingido
- Ordem: mais recente primeiro

---

## Detalhes técnicos importantes

### Formato WhatsApp (Evolution API v1.8.7)

```js
// Texto
POST /message/sendText/{instance}
{ number: "5511999990001", textMessage: { text: "..." } }

// Mídia
POST /message/sendMedia/{instance}
{ number: "...", mediaMessage: { mediatype, mimetype, caption, media, fileName } }

// Áudio
POST /message/sendWhatsAppAudio/{instance}
{ number: "...", audioMessage: { audio: base64 } }

// Webhook
POST /webhook/set/{instance}
{ url: "http://host.docker.internal:3000/webhook", webhookByEvents: false, events: ["MESSAGES_UPSERT"] }
```

### JID @lid (WhatsApp multi-device privacy)
WhatsApp moderno usa `167516643029216@lid` em vez de `5511...@s.whatsapp.net`.
Evolution API rejeita envio direto pra `@lid`.

Solução implementada:
1. `data.sender` no webhook tem JID real da instância (não do cliente)
2. `remoteJid` = JID do cliente (pode ser `@lid`)
3. Resolução: cache → match por pushName no CSV → consulta Evolution API
4. `formatPhone()` passa JIDs com `@` direto sem formatar

### Anti-spam por delay
- Delay aleatório entre `DELAY_MIN` e `DELAY_MAX` ms entre cada envio
- Recomendado: 8–20 segundos para até 150 mensagens/dia
- Acima de 300/dia: risco alto de ban

---

## Comandos

```bash
npm run dashboard   # inicia o dashboard (porta 3000)
npm run connect     # conecta WhatsApp via CLI
npm run status      # verifica status da instância
npm start           # alias para dashboard
```

```bash
# Docker
docker-compose up -d    # sobe Evolution API
docker-compose down     # para
docker-compose logs -f  # ver logs
```

---

## Limites e boas práticas

| Métrica | Recomendado | Risco |
|---|---|---|
| Mensagens/dia | até 150 | >300 = ban |
| Delay mínimo | 8.000 ms | <3.000 ms = suspeito |
| Delay máximo | 20.000 ms | muito curto = padrão robótico |
| Auto-resposta cooldown | 5 min | menor = loop de mensagens |
| Grupos de disparo | <50 pessoas/lote | lotes grandes = flag |

---

## Dados persistidos

| Arquivo | Conteúdo |
|---|---|
| `data/contatos.csv` | base de contatos |
| `data/template.txt` | rascunho atual do template |
| `data/templates.json` | templates salvos com nome |
| `data/autoreplies.json` | regras de auto-resposta |
| `data/campaign_log.json` | histórico de campanhas (50 últimas) |
| `data/groups.json` | grupos de contatos |
| `data/lid_map.json` | cache de resolução @lid → JID |
