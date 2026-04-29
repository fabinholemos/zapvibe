# ZapFlow — Disparador Inteligente de WhatsApp com IA

## Requisitos
- Docker Desktop instalado e rodando
- Node.js 18+ instalado
- Conta gratuita no Groq (console.groq.com)

## Instalacao

### 1. Configure o ambiente
Edite o arquivo `.env` com suas chaves:
```
EVOLUTION_API_KEY=coloque-uma-senha-aqui
GROQ_API_KEY=sua-chave-do-groq
INSTANCE_NAME=nome-da-sua-empresa
```

### 2. Suba a Evolution API
```bash
docker-compose up -d
```

### 3. Instale as dependencias Node
```bash
npm install
```

### 4. Conecte seu WhatsApp
```bash
npm run connect
```
Escaneie o QR Code que aparecer com seu WhatsApp Business.

### 5. Prepare sua lista de contatos
Edite o arquivo `data/contatos.csv` com seus contatos.
Formato: nome, telefone (com DDD), empresa, extra

### 6. Dispare a campanha
```bash
npm start
```

## Configuracoes (.env)

| Variavel | Descricao | Padrao |
|---|---|---|
| DELAY_MIN | Delay minimo entre msgs (ms) | 8000 |
| DELAY_MAX | Delay maximo entre msgs (ms) | 20000 |
| DAILY_LIMIT | Limite de msgs por dia | 150 |
| USE_AI | Usar IA para personalizar | true |

## Estrutura do projeto
```
zapflow/
  src/
    index.js       — entrada principal
    whatsapp.js    — cliente Evolution API
    ai.js          — personalizacao via Groq
    contacts.js    — leitura e validacao CSV
    dispatcher.js  — fila e controle de envio
    logger.js      — logs e relatorio final
    instance.js    — gerencia instancias (multi-tenant)
  data/
    contatos.csv   — sua lista de contatos
    logs/          — relatorios gerados automaticamente
  docker-compose.yml
  .env
  package.json
```

## Boas praticas anti-ban
- Use delay entre 8 e 20 segundos (ja configurado)
- Nao ultrapasse 150 mensagens por dia no inicio
- Use mensagens personalizadas (IA ja faz isso)
- Envie apenas para contatos que te conhecem

## Suporte
Projeto ZapFlow v1.0
