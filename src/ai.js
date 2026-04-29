const Groq = require('groq-sdk')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

async function personalizeMessage(template, contact) {
  if (process.env.USE_AI !== 'true') {
    return applyTemplate(template, contact)
  }

  try {
    const prompt = `Voce e um assistente de comunicacao empresarial.
Reescreva a mensagem abaixo de forma natural e personalizada para o contato.
Mantenha o mesmo conteudo e intencao. Seja direto e profissional.
NAO adicione emojis em excesso. NAO invente informacoes.

Dados do contato:
- Nome: ${contact.nome}
- Empresa: ${contact.empresa || 'nao informado'}
- Info extra: ${contact.extra || ''}

Mensagem base:
${applyTemplate(template, contact)}

Retorne APENAS a mensagem reescrita, sem explicacoes.`

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.7
    })

    return completion.choices[0]?.message?.content?.trim() || applyTemplate(template, contact)
  } catch (err) {
    console.warn(chalk.yellow('IA indisponivel, usando template simples:', err.message))
    return applyTemplate(template, contact)
  }
}

function applyTemplate(template, contact) {
  return template
    .replace(/\{nome\}/gi, contact.nome || '')
    .replace(/\{empresa\}/gi, contact.empresa || '')
    .replace(/\{extra\}/gi, contact.extra || '')
    .replace(/\{telefone\}/gi, contact.telefone || '')
}

module.exports = { personalizeMessage }
