const { sendMessage } = require('./whatsapp')
const { personalizeMessage } = require('./ai')
const chalk = require('chalk')
const ora = require('ora')

const DELAY_MIN = parseInt(process.env.DELAY_MIN) || 8000
const DELAY_MAX = parseInt(process.env.DELAY_MAX) || 20000
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT) || 150

const MESSAGE_TEMPLATE = `Ola, {nome}! Tudo bem?

Estou entrando em contato para apresentar o ZapVibe, nossa solucao de comunicacao via WhatsApp com inteligencia artificial.

Posso te mostrar como funciona em poucos minutos?`

async function dispatch(contacts, template = MESSAGE_TEMPLATE) {
  const results = []
  const limited = contacts.slice(0, DAILY_LIMIT)

  if (contacts.length > DAILY_LIMIT) {
    console.log(chalk.yellow(`⚠  Lista limitada a ${DAILY_LIMIT} msgs/dia (configuravel em .env)\n`))
  }

  console.log(chalk.blue(`📤 Iniciando campanha: ${limited.length} mensagens\n`))

  for (let i = 0; i < limited.length; i++) {
    const contact = limited[i]
    const spinner = ora(`[${i + 1}/${limited.length}] Enviando para ${contact.nome}...`).start()

    try {
      const message = await personalizeMessage(template, contact)
      await sendMessage(contact.telefone, message)

      spinner.succeed(
        chalk.green(`[${i + 1}/${limited.length}] ✔ ${contact.nome}`) +
        chalk.gray(` — ${formatPhone(contact.telefone)}`)
      )

      results.push({
        ...contact,
        status: 'enviado',
        message,
        timestamp: new Date().toISOString()
      })
    } catch (err) {
      spinner.fail(
        chalk.red(`[${i + 1}/${limited.length}] ✘ ${contact.nome}`) +
        chalk.gray(` — ${err.message}`)
      )

      results.push({
        ...contact,
        status: 'falhou',
        erro: err.message,
        timestamp: new Date().toISOString()
      })
    }

    if (i < limited.length - 1) {
      const delay = randomDelay(DELAY_MIN, DELAY_MAX)
      const segundos = (delay / 1000).toFixed(1)
      process.stdout.write(chalk.gray(`   ⏳ Aguardando ${segundos}s...\n`))
      await sleep(delay)
    }
  }

  return results
}

function formatPhone(phone) {
  let num = phone.replace(/\D/g, '')
  if (!num.startsWith('55')) num = '55' + num
  return num
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { dispatch, MESSAGE_TEMPLATE }
