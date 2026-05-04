# Memory Index

- [ZapFlow Project Overview](project_zapflow.md) — Stack, arquitetura, features implementadas, problema @lid, limites anti-ban

## ZapVibe - Histórico técnico recente

### Produção e domínio
- Domínio público em produção: `https://www.zapvibe.com.br`.
- DNS configurado no Registro.br com registros do Railway para o host `www`.
- Railway possui dois serviços principais: `zapvibe` e `evolution-api`.
- `WEBHOOK_BASE_URL` deve permanecer como `https://www.zapvibe.com.br` para configurar webhooks da Evolution em `https://www.zapvibe.com.br/webhook`.
- Start atual do app: `node src/dashboard.js`.

### Correções de deploy/startup
- `package.json` alinhado para iniciar `src/dashboard.js`.
- Helpers CLI antigos em `src/whatsapp.js` restaurados/exportados para compatibilidade.
- `README.md` documenta URL pública, variáveis e operação Railway.

### Webhook e auto-resposta
- Webhook processa eventos `messages.upsert`/`messages_upsert`.
- Proteção anti-eco implementada para campanhas e auto-respostas.
- Cache anti-eco guarda mensagem recente por telefone e por texto normalizado por 10 minutos.
- Auto-respostas enviadas são registradas antes do envio, para ignorar quando a Evolution devolve o próprio envio pelo webhook.
- Logs de diagnóstico adicionados para `fromMe`, payload sem data, mensagem sem remoteJid e duplicidade.

### Bug resolvido: teste com dois WhatsApps conectados
- Sintoma: campanha enviada pelo WhatsApp Principal para outro número próprio; ao responder `quero`, o log mostrava `fromMe=true` e a resposta automática não disparava.
- Causa: os dois números estavam conectados no ZapVibe; a Evolution emitia eventos dos dois lados da conversa.
- Ajuste técnico: deduplicação do webhook agora usa `instanceName + messageId`, não apenas `messageId`.
- Ajuste de produto: aba Conexão ganhou `Habilitar/Desabilitar` por instância.
- Uso recomendado para testes: deixar o disparador habilitado e desabilitar no ZapVibe o número usado como cliente, sem desconectar da Evolution.

### Multi-instância habilitar/desabilitar
- Tabela `user_instances` ganhou coluna `enabled BOOLEAN DEFAULT TRUE` via `db.init()`.
- `getUserInstances()` retorna `enabled`.
- `getUserByInstance()` ignora instâncias desabilitadas.
- Nova rota: `POST /api/instances/:instanceName/enabled` com body `{ enabled: boolean }`.
- UI filtra instâncias desabilitadas nos seletores de campanha e auto-resposta.
- Campanha bloqueia envio se a instância selecionada estiver desabilitada.
- `configureWebhook()` e reconfiguração manual pulam instâncias desabilitadas.

### Commits importantes
- `fc0d9c2` - alinhou startup do dashboard e helpers CLI.
- `2db4e2b` - ajustou seleção/status da instância em campanha.
- `af9f7a0` - permitiu auto-resposta de campanha cruzando instâncias do mesmo usuário.
- `d05d57c` - ignorou eco de campanha recém-enviada.
- `33f3a19` - ignorou eco de auto-resposta enviada.
- `ab55cea` - adicionou logs de diagnóstico no webhook.
- `d9bebf9` - adicionou habilitar/desabilitar WhatsApp e deduplicação por instância.
